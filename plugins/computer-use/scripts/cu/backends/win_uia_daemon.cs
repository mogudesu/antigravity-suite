using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;

namespace CuUiaDaemon
{
    internal static class NativeMethods
    {
        [DllImport("user32.dll")]
        internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("shcore.dll")]
        internal static extern int SetProcessDpiAwareness(int value);

        [DllImport("user32.dll")]
        internal static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        internal static extern IntPtr GetForegroundWindow();
    }

    internal static class Program
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer
        {
            MaxJsonLength = int.MaxValue,
            RecursionLimit = 256
        };

        private static bool EnableDpiAwareness()
        {
            try
            {
                if (NativeMethods.SetProcessDpiAwarenessContext(new IntPtr(-4)))
                {
                    return true;
                }
            }
            catch
            {
            }
            try
            {
                if (NativeMethods.SetProcessDpiAwareness(2) == 0)
                {
                    return true;
                }
            }
            catch
            {
            }
            try
            {
                return NativeMethods.SetProcessDPIAware();
            }
            catch
            {
                return false;
            }
        }

        [STAThread]
        public static int Main(string[] args)
        {
            bool dpiAware = EnableDpiAwareness();
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);

            string line;
            while ((line = Console.ReadLine()) != null)
            {
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                Dictionary<string, object> response;
                object reqId = null;
                try
                {
                    var req = Json.Deserialize<Dictionary<string, object>>(line);
                    if (req != null && req.ContainsKey("id"))
                    {
                        reqId = req["id"];
                    }
                    response = HandleRequest(req, dpiAware);
                }
                catch (Exception ex)
                {
                    response = ErrorResponse("daemon error: " + ex.Message);
                }

                if (reqId != null)
                {
                    response["id"] = reqId;
                }
                Console.WriteLine(Json.Serialize(response));
                Console.Out.Flush();
            }

            return 0;
        }

        private static Dictionary<string, object> HandleRequest(Dictionary<string, object> req, bool dpiAware)
        {
            if (req == null)
            {
                return ErrorResponse("empty request");
            }

            string op = GetString(req, "op", "").ToLowerInvariant();
            switch (op)
            {
                case "ping":
                    return new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "dpiAware", dpiAware },
                        { "pid", Process.GetCurrentProcess().Id }
                    };
                case "tree":
                    return HandleTree(req);
                case "find":
                    return HandleFind(req);
                case "focus":
                    return HandleFocus();
                case "invoke":
                    return HandleInvoke(req);
                case "set_value":
                    return HandleSetValue(req);
                case "quit":
                    Environment.Exit(0);
                    return new Dictionary<string, object> { { "ok", true } };
                default:
                    return ErrorResponse("unknown op: " + op);
            }
        }

        private static AutomationElement ResolveRoot(long hwndVal, out string err)
        {
            err = null;
            IntPtr hwnd = hwndVal > 0 ? new IntPtr(hwndVal) : NativeMethods.GetForegroundWindow();
            if (hwnd == IntPtr.Zero)
            {
                err = "no target or foreground window";
                return null;
            }
            try
            {
                AutomationElement root = AutomationElement.FromHandle(hwnd);
                if (root == null)
                {
                    err = "window handle is not reachable through UI Automation";
                    return null;
                }
                return root;
            }
            catch (Exception ex)
            {
                err = "failed to resolve window: " + ex.Message;
                return null;
            }
        }

        private static Dictionary<string, object> HandleTree(Dictionary<string, object> req)
        {
            string err;
            AutomationElement root = ResolveRoot(GetLong(req, "hwnd", 0), out err);
            if (root == null)
            {
                return ErrorResponse(err);
            }

            int maxDepth = Clamp(GetInt(req, "maxDepth", 6), 1, 25);
            int maxElements = Clamp(GetInt(req, "maxElements", 200), 1, 2000);

            var results = new List<Dictionary<string, object>>();
            var walker = TreeWalker.ControlViewWalker;
            var stack = new Stack<Tuple<AutomationElement, int>>();
            stack.Push(Tuple.Create(root, 0));

            while (stack.Count > 0 && results.Count < maxElements)
            {
                var item = stack.Pop();
                AutomationElement el = item.Item1;
                int depth = item.Item2;
                var info = ElementToDict(el, depth, false);
                if (info != null)
                {
                    results.Add(info);
                }

                if (depth >= maxDepth)
                {
                    continue;
                }

                var children = new List<AutomationElement>();
                try
                {
                    AutomationElement child = walker.GetFirstChild(el);
                    int guard = 0;
                    while (child != null && guard < maxElements)
                    {
                        children.Add(child);
                        child = walker.GetNextSibling(child);
                        guard++;
                    }
                }
                catch
                {
                }

                for (int i = children.Count - 1; i >= 0; i--)
                {
                    stack.Push(Tuple.Create(children[i], depth + 1));
                }
            }

            return new Dictionary<string, object>
            {
                { "ok", true },
                { "elements", results }
            };
        }

        private static AutomationElement WalkAndMatch(
            AutomationElement root,
            string query,
            string elementId,
            int maxDepth,
            int scanBudget,
            List<Tuple<int, AutomationElement, Dictionary<string, object>>> rankedMatches)
        {
            string qLower = string.IsNullOrEmpty(query) ? "" : query.Trim().ToLowerInvariant();
            string idWanted = string.IsNullOrEmpty(elementId) ? "" : elementId.Trim();
            string idLower = idWanted.ToLowerInvariant();

            var walker = TreeWalker.ControlViewWalker;
            var stack = new Stack<Tuple<AutomationElement, int>>();
            stack.Push(Tuple.Create(root, 0));
            int scanned = 0;

            while (stack.Count > 0 && scanned < scanBudget)
            {
                var item = stack.Pop();
                AutomationElement el = item.Item1;
                int depth = item.Item2;
                scanned++;

                string name = "";
                string autoId = "";
                bool offscreen = false;
                try
                {
                    name = el.Current.Name ?? "";
                    autoId = el.Current.AutomationId ?? "";
                    offscreen = el.Current.IsOffscreen;
                }
                catch
                {
                    continue;
                }

                int rank = -1;
                if (!string.IsNullOrEmpty(idWanted))
                {
                    if (string.Equals(autoId, idWanted, StringComparison.Ordinal))
                    {
                        rank = 0;
                    }
                    else if (string.Equals(autoId, idWanted, StringComparison.OrdinalIgnoreCase))
                    {
                        rank = 1;
                    }
                    else if (!string.IsNullOrEmpty(autoId) && autoId.ToLowerInvariant().Contains(idLower))
                    {
                        rank = 3;
                    }
                }
                else if (!string.IsNullOrEmpty(qLower))
                {
                    string nameL = name.ToLowerInvariant();
                    string autoL = autoId.ToLowerInvariant();
                    if (autoL == qLower || nameL == qLower)
                    {
                        rank = 1;
                    }
                    else if (nameL.Contains(qLower) || autoL.Contains(qLower))
                    {
                        rank = 2;
                    }
                }

                if (rank >= 0)
                {
                    if (offscreen)
                    {
                        rank += 10;
                    }
                    var dict = ElementToDict(el, depth, false);
                    if (dict != null)
                    {
                        rankedMatches.Add(Tuple.Create(rank, el, dict));
                    }
                }

                if (depth >= maxDepth)
                {
                    continue;
                }

                var children = new List<AutomationElement>();
                try
                {
                    AutomationElement child = walker.GetFirstChild(el);
                    int guard = 0;
                    while (child != null && guard < 300)
                    {
                        children.Add(child);
                        child = walker.GetNextSibling(child);
                        guard++;
                    }
                }
                catch
                {
                }

                for (int i = children.Count - 1; i >= 0; i--)
                {
                    stack.Push(Tuple.Create(children[i], depth + 1));
                }
            }

            if (rankedMatches.Count == 0)
            {
                return null;
            }
            rankedMatches.Sort((a, b) => a.Item1.CompareTo(b.Item1));
            return rankedMatches[0].Item2;
        }

        private static Dictionary<string, object> HandleFind(Dictionary<string, object> req)
        {
            string err;
            AutomationElement root = ResolveRoot(GetLong(req, "hwnd", 0), out err);
            if (root == null)
            {
                return ErrorResponse(err);
            }

            string query = GetString(req, "query", "");
            string elementId = GetString(req, "elementId", "");
            if (string.IsNullOrWhiteSpace(query) && string.IsNullOrWhiteSpace(elementId))
            {
                return ErrorResponse("query or elementId is required");
            }

            int limit = Clamp(GetInt(req, "limit", 20), 1, 200);
            int maxDepth = Clamp(GetInt(req, "maxDepth", 15), 1, 25);
            var matches = new List<Tuple<int, AutomationElement, Dictionary<string, object>>>();
            WalkAndMatch(root, query, elementId, maxDepth, 2500, matches);

            var elements = new List<Dictionary<string, object>>();
            for (int i = 0; i < matches.Count && elements.Count < limit; i++)
            {
                elements.Add(matches[i].Item3);
            }
            return new Dictionary<string, object>
            {
                { "ok", true },
                { "elements", elements }
            };
        }

        private static Dictionary<string, object> HandleFocus()
        {
            try
            {
                AutomationElement focused = AutomationElement.FocusedElement;
                if (focused == null)
                {
                    return new Dictionary<string, object> { { "ok", true }, { "element", null } };
                }
                var dict = ElementToDict(focused, 0, false);
                return new Dictionary<string, object> { { "ok", true }, { "element", dict } };
            }
            catch
            {
                return new Dictionary<string, object> { { "ok", true }, { "element", null } };
            }
        }

        private static Dictionary<string, object> HandleInvoke(Dictionary<string, object> req)
        {
            string err;
            AutomationElement root = ResolveRoot(GetLong(req, "hwnd", 0), out err);
            if (root == null)
            {
                return ErrorResponse(err);
            }

            string query = GetString(req, "query", "");
            string elementId = GetString(req, "elementId", "");
            var matches = new List<Tuple<int, AutomationElement, Dictionary<string, object>>>();
            AutomationElement target = WalkAndMatch(root, query, elementId, 16, 2500, matches);
            if (target == null)
            {
                return ErrorResponse("no matching control found");
            }

            Dictionary<string, object> elDict = matches[0].Item3;
            bool enabled = true;
            try
            {
                enabled = target.Current.IsEnabled;
            }
            catch
            {
            }
            if (!enabled)
            {
                string label = GetString(elDict, "name", "") + GetString(elDict, "automationId", "");
                return ErrorResponse("control is disabled: " + label);
            }

            string action = "none";
            try
            {
                object obj;
                if (target.TryGetCurrentPattern(InvokePattern.Pattern, out obj))
                {
                    ((InvokePattern)obj).Invoke();
                    action = "invoke";
                }
                else if (target.TryGetCurrentPattern(SelectionItemPattern.Pattern, out obj))
                {
                    ((SelectionItemPattern)obj).Select();
                    action = "select";
                }
                else if (target.TryGetCurrentPattern(TogglePattern.Pattern, out obj))
                {
                    ((TogglePattern)obj).Toggle();
                    action = "toggle";
                }
                else if (target.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out obj))
                {
                    var ec = (ExpandCollapsePattern)obj;
                    if (ec.Current.ExpandCollapseState == ExpandCollapseState.Collapsed)
                    {
                        ec.Expand();
                    }
                    else
                    {
                        ec.Collapse();
                    }
                    action = "expand";
                }
            }
            catch (Exception ex)
            {
                return ErrorResponse("failed to activate control: " + ex.Message);
            }

            return new Dictionary<string, object>
            {
                { "ok", true },
                { "invoked", action != "none" },
                { "action", action },
                { "element", elDict }
            };
        }

        private static Dictionary<string, object> HandleSetValue(Dictionary<string, object> req)
        {
            string err;
            AutomationElement root = ResolveRoot(GetLong(req, "hwnd", 0), out err);
            if (root == null)
            {
                return ErrorResponse(err);
            }

            string query = GetString(req, "query", "");
            string elementId = GetString(req, "elementId", "");
            string text = GetString(req, "text", "");
            var matches = new List<Tuple<int, AutomationElement, Dictionary<string, object>>>();
            AutomationElement target = WalkAndMatch(root, query, elementId, 16, 2500, matches);
            if (target == null)
            {
                return ErrorResponse("no matching control found");
            }

            Dictionary<string, object> elDict = matches[0].Item3;
            try
            {
                if (target.Current.IsPassword)
                {
                    return ErrorResponse("refusing to write into a password field");
                }
                if (!target.Current.IsEnabled)
                {
                    return ErrorResponse("control is disabled");
                }
                object obj;
                if (target.TryGetCurrentPattern(ValuePattern.Pattern, out obj))
                {
                    var vp = (ValuePattern)obj;
                    if (vp.Current.IsReadOnly)
                    {
                        return ErrorResponse("control is read-only");
                    }
                    vp.SetValue(text);
                    return new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "action", "value" },
                        { "element", elDict }
                    };
                }
                return ErrorResponse("control does not support ValuePattern");
            }
            catch (Exception ex)
            {
                return ErrorResponse("set_value failed: " + ex.Message);
            }
        }

        private static Dictionary<string, object> ElementToDict(AutomationElement el, int depth, bool includeValue)
        {
            try
            {
                var cur = el.Current;
                string ctype = "";
                if (cur.ControlType != null && cur.ControlType.ProgrammaticName != null)
                {
                    ctype = cur.ControlType.ProgrammaticName.Replace("ControlType.", "");
                }

                bool isPwd = cur.IsPassword;
                Rect r = cur.BoundingRectangle;
                Dictionary<string, object> rectDict = null;
                if (!r.IsEmpty && !double.IsInfinity(r.X) && !double.IsInfinity(r.Y) &&
                    !double.IsInfinity(r.Width) && !double.IsInfinity(r.Height) &&
                    r.Width > 0 && r.Height > 0)
                {
                    rectDict = new Dictionary<string, object>
                    {
                        { "x", (int)Math.Round(r.X) },
                        { "y", (int)Math.Round(r.Y) },
                        { "width", (int)Math.Round(r.Width) },
                        { "height", (int)Math.Round(r.Height) }
                    };
                }

                var patterns = new List<string>();
                string valueText = null;
                try
                {
                    foreach (AutomationPattern pat in el.GetSupportedPatterns())
                    {
                        string pname = Automation.PatternName(pat) ?? "";
                        if (pname.EndsWith("Pattern", StringComparison.Ordinal))
                        {
                            pname = pname.Substring(0, pname.Length - "Pattern".Length);
                        }
                        if (!string.IsNullOrEmpty(pname))
                        {
                            patterns.Add(pname);
                        }
                    }
                }
                catch
                {
                }

                if (!isPwd && patterns.Contains("Value"))
                {
                    try
                    {
                        object obj;
                        if (el.TryGetCurrentPattern(ValuePattern.Pattern, out obj))
                        {
                            string v = ((ValuePattern)obj).Current.Value;
                            if (!string.IsNullOrEmpty(v))
                            {
                                valueText = v.Length > 200 ? v.Substring(0, 200) : v;
                            }
                        }
                    }
                    catch
                    {
                    }
                }

                int hwnd = 0;
                int pid = 0;
                try
                {
                    hwnd = cur.NativeWindowHandle;
                    pid = cur.ProcessId;
                }
                catch
                {
                }

                var dict = new Dictionary<string, object>
                {
                    { "name", cur.Name ?? "" },
                    { "automationId", cur.AutomationId ?? "" },
                    { "controlType", ctype },
                    { "className", cur.ClassName ?? "" },
                    { "depth", depth },
                    { "isEnabled", cur.IsEnabled },
                    { "isOffscreen", cur.IsOffscreen },
                    { "isPassword", isPwd },
                    { "password", isPwd },
                    { "hasKeyboardFocus", cur.HasKeyboardFocus },
                    { "processId", pid },
                    { "hwnd", hwnd },
                    { "rect", rectDict },
                    { "patterns", patterns }
                };
                if (valueText != null)
                {
                    dict["value"] = valueText;
                }
                return dict;
            }
            catch
            {
                return null;
            }
        }

        private static Dictionary<string, object> ErrorResponse(string message)
        {
            return new Dictionary<string, object>
            {
                { "ok", false },
                { "error", message ?? "unknown error" }
            };
        }

        private static string GetString(Dictionary<string, object> dict, string key, string fallback)
        {
            object val;
            if (dict != null && dict.TryGetValue(key, out val) && val != null)
            {
                return Convert.ToString(val) ?? fallback;
            }
            return fallback;
        }

        private static int GetInt(Dictionary<string, object> dict, string key, int fallback)
        {
            object val;
            if (dict != null && dict.TryGetValue(key, out val) && val != null)
            {
                try
                {
                    return Convert.ToInt32(val);
                }
                catch
                {
                }
            }
            return fallback;
        }

        private static long GetLong(Dictionary<string, object> dict, string key, long fallback)
        {
            object val;
            if (dict != null && dict.TryGetValue(key, out val) && val != null)
            {
                try
                {
                    return Convert.ToInt64(val);
                }
                catch
                {
                }
            }
            return fallback;
        }

        private static int Clamp(int value, int minVal, int maxVal)
        {
            if (value < minVal) return minVal;
            if (value > maxVal) return maxVal;
            return value;
        }
    }
}
