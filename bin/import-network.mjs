import { spawnSync } from 'node:child_process';

// Keep the machine's proxy settings scoped to the temporary import connector.
export function importNetworkEnv(env = process.env, platform = process.platform, run = spawnSync) {
  const result = { ...env, npm_config_fetch_retries: '0', npm_config_fetch_timeout: '30000', npm_config_loglevel: 'error' };
  if (platform === 'win32' && !(env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy)) {
    const probe = run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $targets=@('https://app.base44.com','https://npm.jsr.io'); $values=@(); foreach($target in $targets) { $uri=[uri]$target; $proxy=[System.Net.WebRequest]::DefaultWebProxy.GetProxy($uri); if($proxy -and $proxy -ne $uri) { $values += $proxy.AbsoluteUri } else { $values += '' } }; ConvertTo-Json -InputObject $values -Compress"
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 10000 });
    if (probe.status === 0) {
      try {
        const proxies = JSON.parse(probe.stdout);
        const valid = value => typeof value === 'string' && /^https?:\/\//i.test(value);
        if (valid(proxies[0])) result.HTTPS_PROXY = proxies[0];
        if (!env.npm_config_https_proxy && valid(proxies[1])) result.npm_config_https_proxy = proxies[1];
      } catch { /* Preserve direct access if system proxy discovery is unavailable. */ }
    }
  }
  if (result.HTTPS_PROXY || result.https_proxy || result.HTTP_PROXY || result.http_proxy) {
    result.NODE_USE_ENV_PROXY ??= '1';
  }
  return result;
}
