/** Human-readable formatting shared by the model-facing summary and the CLI. */

const KIB = 1024
const BYTE_UNITS = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB']

/**
 * Format a byte count with binary units.
 * @param {number} n
 * @returns {string}
 */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return 'unknown'
  if (n < KIB) return `${Math.round(n)} B`
  let value = n / KIB
  let index = 0
  while (value >= KIB && index < BYTE_UNITS.length - 1) {
    value /= KIB
    index += 1
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${BYTE_UNITS[index]}`
}

/**
 * Format a duration in milliseconds as a short age such as `42s`, `7m28s`, `4h16m`.
 * @param {number} ms
 * @returns {string}
 */
export function formatAge(ms) {
  if (!Number.isFinite(ms)) return 'unknown'
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24}h`
}

/**
 * Format a 0..1 fraction as one-decimal percent.
 * @param {number} fraction
 * @returns {string}
 */
export function formatPercent(fraction) {
  if (!Number.isFinite(fraction)) return 'unknown'
  return `${(fraction * 100).toFixed(1)}%`
}

/**
 * ISO-8601 timestamp carrying the local UTC offset.
 * @param {number} ms epoch milliseconds
 * @returns {string}
 */
export function isoLocal(ms) {
  if (!Number.isFinite(ms)) return 'unknown'
  const date = new Date(ms)
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const pad = value => String(Math.floor(Math.abs(value))).padStart(2, '0')
  const body = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return `${body}${sign}${pad(offset / 60)}:${pad(offset % 60)}`
}

/**
 * Local clock time, seconds precision.
 * @param {number} ms epoch milliseconds
 * @returns {string}
 */
export function clockLocal(ms) {
  if (!Number.isFinite(ms)) return 'unknown'
  const date = new Date(ms)
  const pad = value => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Format a millisecond duration for collector timings.
 * @param {number} ms
 * @returns {string}
 */
export function formatMs(ms) {
  if (!Number.isFinite(ms)) return 'unknown'
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}

/**
 * Capitalize a state token for display.
 * @param {string} value
 * @returns {string}
 */
export function upper(value) {
  return typeof value === 'string' ? value.toUpperCase() : 'UNKNOWN'
}
