/**
 * Sidecar 入口：Antigravity 按 sidecar.json 的 command/args 在当前目录拉起本文件。
 * 真正的守护逻辑在 ../../src/index.mjs，这里只做一次转发，保证 cwd 无关。
 */
import '../../src/index.mjs';
