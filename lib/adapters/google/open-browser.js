/**
 * Best-effort OS browser opener.
 *
 * The harness GUI and the OAuth loopback listener normally run on the same
 * machine, so opening the consent page saves a copy/paste. Failure is never
 * fatal: the authorization URL is always returned to the model and the user.
 * @module @local/docs-connector/adapters/google/open-browser
 */
import { spawn } from 'node:child_process'

/**
 * Create an opener for the current OS.
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform] - platform override (tests).
 * @param {object} [options.logger] - optional logger.
 * @returns {(url: string) => boolean} opener returning whether a process was started.
 */
export function createSystemBrowserOpener({ platform = process.platform, logger } = {}) {
  return (url) => {
    const command = platform === 'darwin'
      ? 'open'
      : platform === 'win32'
        ? 'rundll32'
        : 'xdg-open'
    const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' })
      child.on('error', (error) => {
        logger?.warn?.(`could not open the browser: ${error.message}`)
      })
      child.unref()
      return true
    } catch (error) {
      logger?.warn?.(`could not open the browser: ${error instanceof Error ? error.message : error}`)
      return false
    }
  }
}
