/**
 * QQ 官方机器人扫码连接：调 @tencent-connect/qqbot-connector 的 startQrConnect，
 * 手机 QQ 扫一下就能拿到 AppID + AppSecret，不用去开放平台后台抄。
 */
import { startQrConnect } from '@tencent-connect/qqbot-connector';

/**
 * 发起扫码。返回 { stop, done }：done 在扫码成功后 resolve 出凭据数组。
 * @param {{onQr: (url: string) => void, onStatus?: (status: string) => void, source?: string}} options
 */
export function startQrScan({ onQr, onStatus, source = 'antigravity-remote-mogu' } = {}) {
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const controller = new AbortController();
  const dispose = startQrConnect({
    displayQrCodeToConsole: false,
    source,
    signal: controller.signal,
    onQrDisplayed: (url) => {
      onStatus?.('wait');
      onQr?.(url);
    },
    onQrExpired: () => onStatus?.('expired'),
    onSuccess: (credentials) => {
      onStatus?.('confirmed');
      resolveDone(credentials);
    },
    onFailure: (error) => {
      onStatus?.('error');
      rejectDone(error instanceof Error ? error : new Error(String(error)));
    },
  });

  return {
    done,
    stop() {
      try {
        controller.abort();
        dispose?.();
      } catch {
        /* ignore */
      }
    },
  };
}

/** 用官方接口校验 AppID/AppSecret（拿到 access_token 就算通过）。 */
export async function verifyCredentials({ appId, appSecret } = {}) {
  if (!appId || !appSecret) throw new Error('AppID 与 AppSecret 必填');
  const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) {
    throw new Error(`QQ 凭据校验失败：${data.message || data.code || '没有返回 access_token'}`);
  }
  return { ok: true, expiresIn: Number(data.expires_in || 0) };
}
