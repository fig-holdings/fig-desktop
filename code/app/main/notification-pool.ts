interface NativeNotification {once(event: string, callback: () => void): unknown; show(): void; close(): void}
/** Electron's native click target must stay strongly reachable until click/close/failure. */
export class NotificationPool {
  private live = new Set<NativeNotification>()
  constructor(private limit = 64) {}
  get size() {return this.live.size}
  show(notification: NativeNotification, click: () => void) {
    while (this.live.size >= this.limit) {
      const oldest = this.live.values().next().value!; this.live.delete(oldest)
      try {oldest.close()} catch {}
    }
    this.live.add(notification)
    const release = () => {this.live.delete(notification)}
    notification.once('click', () => {release(); click()})
    notification.once('close', release); notification.once('failed', release)
    try {notification.show()} catch {release()}
  }
  dispose() {for (const item of this.live) {try {item.close()} catch {}}; this.live.clear()}
}
