/**
 * resource-actions.js
 * 插件/技能「打开位置」菜单与设置页技能卡片布局修复。
 *
 * - 插件列表中三点菜单缺少“打开插件位置”时按需补一项。
 * - 技能菜单缺少“打开文件位置”时补一项，优先触发原生“复制路径”取得路径。
 * - 设置弹窗的“技能”列表持续补 ag-skill-grid / ag-skill-card 类，恢复两列卡片。
 */
(function () {
  if (window.__agResourceActionsInstalled) return;
  window.__agResourceActionsInstalled = true;

  const STYLE_ID = "ag-resource-actions-style";
  const TOAST_ID = "ag-resource-actions-toast";
  const SIDECAR = () => "http://127.0.0.1:" + (window.__AG_SIDECAR_PORT || 39290);
  const FOLDER_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H447l-80-80H160v480Zm0 0v-480 480Z"/></svg>';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${TOAST_ID}{position:fixed;left:50%;bottom:34px;transform:translate(-50%,8px);z-index:10005;padding:7px 12px;border:1px solid rgba(196,181,253,.2);border-radius:999px;background:rgba(12,14,26,.95);color:#e9eef8;font:500 11px/1.4 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;opacity:0;pointer-events:none;transition:opacity .16s,transform .16s}
      #${TOAST_ID}.is-visible{opacity:1;transform:translate(-50%,0)}
    `;
    document.head.appendChild(style);
  }

  function toast(message) {
    ensureStyle();
    let node = document.getElementById(TOAST_ID);
    if (!node) {
      node = document.createElement("div");
      node.id = TOAST_ID;
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.classList.add("is-visible");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove("is-visible"), 1800);
  }

  async function buildPath(payload) {
    const response = await fetch(SIDECAR() + "/api/open-resource", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || ("HTTP " + response.status));
    return data.path || "";
  }

  async function openResource(payload, label) {
    try {
      await buildPath(payload);
      toast(label + "已打开");
    } catch (error) {
      toast(label + "打开失败：" + (error.message || error));
    }
  }

  function closeMenus() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  }

  function pluginCardFor(trigger) {
    return trigger && trigger.closest ? trigger.closest("[data-card-name]") : null;
  }

  function pluginSlug(card) {
    if (!card) return "";
    const link = card.querySelector('a[href^="/customizations/plugins/"]');
    if (!link) return "";
    return decodeURIComponent(String(link.getAttribute("href") || "").split("/").filter(Boolean).pop() || "");
  }

  function skillRowFor(trigger) {
    if (!trigger || !trigger.closest) return null;
    const row = trigger.closest(".group.relative.flex.items-center");
    if (!row) return null;
    const label = row.querySelector("span.text-sm.font-medium");
    return label && String(label.textContent || "").trim().startsWith("/") ? row : null;
  }

  function skillNameFor(trigger, row) {
    if (row) {
      const label = row.querySelector("span.text-sm.font-medium");
      if (label) return String(label.textContent || "").trim().replace(/^\/+/, "");
    }
    const aria = trigger ? String(trigger.getAttribute("aria-label") || "") : "";
    const match = aria.match(/^More actions for (.+)$/i);
    return match ? match[1].trim().replace(/^\/+/, "") : "";
  }

  function makeMenuItem(template, label) {
    const item = template.cloneNode(true);
    item.removeAttribute("id");
    item.removeAttribute("data-highlighted");
    item.setAttribute("role", "menuitem");
    item.setAttribute("tabindex", "0");
    item.setAttribute("data-ag-open-resource", "1");
    item.innerHTML = `<span class="flex items-center gap-1.5">${FOLDER_ICON}<span>${label}</span></span>`;
    return item;
  }

  function nativeOpenItems(menu) {
    return Array.from(menu.querySelectorAll('[role="menuitem"]'))
      .filter((item) => !item.hasAttribute("data-ag-open-resource") && /打开(插件|文件)位置/.test(item.innerText || ""));
  }

  function dedupeOpenItems(menu) {
    const ours = Array.from(menu.querySelectorAll("[data-ag-open-resource]"));
    if (ours.length > 1) ours.slice(1).forEach((item) => item.remove());
    const natives = nativeOpenItems(menu);
    if (!natives.length || !ours.length) return;
    ours.forEach((item) => item.remove());
  }

  function enhanceMenu(menu) {
    if (!menu) return;
    dedupeOpenItems(menu);
    if (menu.getAttribute("data-ag-resource-menu") === "1") return;
    const labelId = menu.getAttribute("aria-labelledby");
    const trigger = (labelId && document.getElementById(labelId)) || document.activeElement;
    const aria = String(trigger?.getAttribute?.("aria-label") || "");
    if (!/^More actions for /i.test(aria)) return;
    const card = pluginCardFor(trigger);
    const skillRow = skillRowFor(trigger);
    if (!card && !skillRow) return;
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    if (!items.length) return;
    const already = items.some((item) => /打开(插件|文件)位置/.test(item.innerText || ""));
    if (already) {
      menu.setAttribute("data-ag-resource-menu", "1");
      return;
    }
    const copyItem = items.find((item) => /复制路径/.test(item.innerText || ""));
    const template = copyItem || items[0];
    const item = makeMenuItem(template, card ? "打开插件位置" : "打开文件位置");
    item.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (card) {
        const id = pluginSlug(card);
        closeMenus();
        openResource({ kind: "plugin", id, name: String(card.getAttribute("data-card-name") || "") }, "插件位置");
        return;
      }
      const name = skillNameFor(trigger, skillRow);
      if (copyItem) {
        try { copyItem.click(); } catch (error) { /* ignore */ }
        setTimeout(async () => {
          let copied = "";
          try { copied = await navigator.clipboard.readText(); } catch (error) { /* ignore */ }
          copied = String(copied || "").trim().replace(/^"|"$/g, "");
          if (copied.startsWith("file:///")) {
            try { copied = decodeURIComponent(copied.slice(8)).replace(/^\//, "").replace(/\//g, "\\"); } catch (error) { /* ignore */ }
          }
          if (copied) openResource({ kind: "skill", path: copied, name }, "文件位置");
          else openResource({ kind: "skill", name }, "文件位置");
        }, 160);
      } else {
        closeMenus();
        openResource({ kind: "skill", name }, "文件位置");
      }
    }, true);
    if (copyItem) menu.insertBefore(item, copyItem);
    else menu.insertBefore(item, menu.firstChild);
    menu.setAttribute("data-ag-resource-menu", "1");
  }

  function scanMenus() {
    document.querySelectorAll('[role="menu"]').forEach(enhanceMenu);
  }

  function decorateSettingsSkills() {
    const modal = document.querySelector(".settings-modal-container");
    if (!modal) return;
    const headings = Array.from(modal.querySelectorAll("h2,h3")).filter((node) =>
      String(node.textContent || "").trim() === "技能"
    );
    headings.forEach((heading) => {
      const scope = heading.closest(".space-y-2");
      if (!scope) return;
      const lists = Array.from(scope.querySelectorAll(".border.border-border.rounded-xl.overflow-hidden"))
        .filter((list) => list.querySelectorAll(":scope > .group").length > 2);
      lists.forEach((list) => {
        list.classList.add("ag-skill-grid");
        Array.from(list.children).forEach((child) => {
          if (child.classList && child.classList.contains("group")) child.classList.add("ag-skill-card");
        });
      });
    });
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      scanMenus();
      decorateSettingsSkills();
    });
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    if (target.closest("[data-testid^='settings-nav-item-'], [data-testid='settings-button']")) {
      setTimeout(decorateSettingsSkills, 120);
    }
  }, true);

  const timer = setInterval(() => {
    scanMenus();
    decorateSettingsSkills();
  }, 1500);

  function dispose() {
    observer.disconnect();
    clearInterval(timer);
    document.querySelectorAll("[data-ag-open-resource]").forEach((node) => node.remove());
    document.querySelectorAll(".ag-skill-grid").forEach((node) => node.classList.remove("ag-skill-grid"));
    document.querySelectorAll(".ag-skill-card").forEach((node) => node.classList.remove("ag-skill-card"));
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById(TOAST_ID)?.remove();
  }

  window.__agResourceActionsDispose = dispose;
  schedule();
  window.__agResourceActions = { version: "1.0.0", scan: schedule };
})();
