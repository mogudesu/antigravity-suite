<#
  UI Automation bridge for the computer-use MCP server.

  Reads a window's accessibility tree, searches it, or activates a matching
  element. A single JSON object is written to stdout; every failure is
  reported as {"error": "..."} so the caller can show a readable message
  instead of a PowerShell stack trace.
#>
[CmdletBinding()]
param(
  [ValidateSet('tree', 'find', 'focus', 'invoke')][string]$Mode = 'tree',
  [string]$Title = '',
  [string]$Query = '',
  [string]$Handle = '',
  [int]$MaxDepth = 6,
  [int]$MaxElements = 200
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function Write-Result($payload) {
  $payload | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

function Write-Problem($message) {
  [pscustomobject]@{ error = [string]$message } | ConvertTo-Json -Compress
  exit 0
}

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes

  if (-not ('CuNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CuNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
}
'@
  }

  $Element = [System.Windows.Automation.AutomationElement]
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

  function Convert-Element($element, $depth) {
    $current = $element.Current
    $rect = $current.BoundingRectangle
    $x = 0; $y = 0; $w = 0; $h = 0
    if (-not [double]::IsNaN($rect.X) -and -not [double]::IsInfinity($rect.X)) {
      $x = [int]$rect.X; $y = [int]$rect.Y; $w = [int]$rect.Width; $h = [int]$rect.Height
    }
    $patterns = @()
    try { foreach ($p in $element.GetSupportedPatterns()) { $patterns += ($p.ProgrammaticName -replace 'Pattern$', '') } } catch { }
    $isPassword = $false
    try { $isPassword = [bool]$current.IsPassword } catch { }
    $value = $null
    if (-not $isPassword) {
      try {
        $vp = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $value = [string]$vp.Current.Value
      } catch { }
    }
    [pscustomobject]@{
      depth        = $depth
      name         = [string]$current.Name
      controlType  = ([string]$current.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
      automationId = [string]$current.AutomationId
      className    = [string]$current.ClassName
      enabled      = [bool]$current.IsEnabled
      offscreen    = [bool]$current.IsOffscreen
      password     = $isPassword
      patterns     = $patterns
      value        = $value
      rect         = [pscustomobject]@{ x = $x; y = $y; width = $w; height = $h }
    }
  }

  function Get-RootWindow {
    if ($Handle -ne '') {
      return $Element::FromHandle([IntPtr]([int64]$Handle))
    }
    if ($Title -ne '') {
      $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window)
      $children = $Element::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
      foreach ($child in $children) {
        if ([string]$child.Current.Name -like "*$Title*") { return $child }
      }
      throw "no window matched title '$Title'"
    }
    return $Element::FromHandle([CuNative]::GetForegroundWindow())
  }

  function Find-Matching($node, $depth, $collector) {
    if ($null -eq $node -or $collector.Count -ge $MaxElements) { return }
    $name = ''; $automationId = ''
    try { $name = [string]$node.Current.Name } catch { }
    try { $automationId = [string]$node.Current.AutomationId } catch { }
    if (($name -ne '' -and $name -like "*$Query*") -or ($automationId -ne '' -and $automationId -like "*$Query*")) {
      [void]$collector.Add($node)
    }
    if ($depth -ge $MaxDepth) { return }
    $child = $walker.GetFirstChild($node)
    while ($null -ne $child) {
      Find-Matching $child ($depth + 1) $collector
      if ($collector.Count -ge $MaxElements) { return }
      $child = $walker.GetNextSibling($child)
    }
  }

  $root = Get-RootWindow
  if ($null -eq $root) { Write-Problem 'no target window found' }

  switch ($Mode) {
    'focus' {
      $focused = $Element::FocusedElement
      if ($null -eq $focused) { Write-Problem 'no element currently has focus' }
      Write-Result ([pscustomobject]@{ element = (Convert-Element $focused 0) })
    }
    'tree' {
      $elements = New-Object System.Collections.ArrayList
      $script:collected = $elements
      function Walk($node, $depth) {
        if ($null -eq $node -or $script:collected.Count -ge $MaxElements) { return }
        [void]$script:collected.Add((Convert-Element $node $depth))
        if ($depth -ge $MaxDepth) { return }
        $child = $walker.GetFirstChild($node)
        while ($null -ne $child) {
          Walk $child ($depth + 1)
          if ($script:collected.Count -ge $MaxElements) { return }
          $child = $walker.GetNextSibling($child)
        }
      }
      Walk $root 0
      # Wrap in @() so a single-element tree is still emitted as a JSON array
      # by Windows PowerShell 5.1's ConvertTo-Json.
      $elements = @($elements.ToArray())
      Write-Result ([pscustomobject]@{
        elements  = $elements
        count     = $elements.Count
        truncated = ($elements.Count -ge $MaxElements)
      })
    }
    'find' {
      if ($Query -eq '') { Write-Problem 'Query is required for find' }
      $collector = New-Object System.Collections.ArrayList
      Find-Matching $root 0 $collector
      $elements = New-Object System.Collections.ArrayList
      foreach ($node in $collector) { [void]$elements.Add((Convert-Element $node 0)) }
      # A single match must still be a standard JSON array, not an object.
      $elements = @($elements.ToArray())
      Write-Result ([pscustomobject]@{ elements = $elements; count = $elements.Count })
    }
    'invoke' {
      if ($Query -eq '') { Write-Problem 'Query is required for invoke' }
      $collector = New-Object System.Collections.ArrayList
      Find-Matching $root 0 $collector
      if ($collector.Count -eq 0) { Write-Problem "no element matched '$Query'" }
      $target = $collector[0]
      $info = Convert-Element $target 0
      $invoked = $false
      $action = ''
      try {
        $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $invoked = $true; $action = 'invoke'
      } catch {
        try {
          $target.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
          $invoked = $true; $action = 'select'
        } catch {
          try {
            $target.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
            $invoked = $true; $action = 'toggle'
          } catch { }
        }
      }
      Write-Result ([pscustomobject]@{
        invoked = $invoked
        action  = $action
        matches = $collector.Count
        element = $info
      })
    }
  }
} catch {
  Write-Problem $_.Exception.Message
}
