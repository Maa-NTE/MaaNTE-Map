import { DEFAULT_NAVIGATION_WEBSOCKET_URL } from '../constants/mapApp'

const WILDCARD_HOST = '0.0.0.0'

// 把 ws://host:port 或 wss://host:port 拆成表单可编辑的协议、主机和端口。
export function parseNavigationWebSocketUrl(url = DEFAULT_NAVIGATION_WEBSOCKET_URL) {
  try {
    const parsed = new URL(url)
    return {
      protocol: parsed.protocol === 'wss:' ? 'wss' : 'ws',
      host: parsed.hostname || '127.0.0.1',
      port: parsed.port || '14514',
    }
  } catch {
    return { protocol: 'ws', host: '127.0.0.1', port: '14514' }
  }
}

export function normalizeNavigationProtocol(value) {
  return value === 'wss' ? 'wss' : parseNavigationWebSocketUrl().protocol
}

export function normalizeNavigationHost(value) {
  return String(value || '').trim() || parseNavigationWebSocketUrl().host
}

export function isWildcardNavigationHost(value) {
  return normalizeNavigationHost(value) === WILDCARD_HOST
}

// 端口只接受 1-65535 的整数，非法输入回退到默认导航服务端口。
export function normalizeNavigationPort(value) {
  const port = Number(String(value || '').trim())
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? String(port)
    : parseNavigationWebSocketUrl().port
}
