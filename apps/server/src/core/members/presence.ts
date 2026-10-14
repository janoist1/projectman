/** Which users have an open websocket (drives the online/offline status of human members). */
export class PresenceService {
  private readonly connections = new Map<string, number>();

  /** Returns true when the user just came online. */
  connect(email: string): boolean {
    const key = email.trim().toLowerCase();
    const count = (this.connections.get(key) ?? 0) + 1;
    this.connections.set(key, count);
    return count === 1;
  }

  /** Returns true when the user just went offline. */
  disconnect(email: string): boolean {
    const key = email.trim().toLowerCase();
    const count = (this.connections.get(key) ?? 0) - 1;
    if (count <= 0) {
      this.connections.delete(key);
      return true;
    }
    this.connections.set(key, count);
    return false;
  }

  isOnline(email: string | undefined): boolean {
    return email ? this.connections.has(email.trim().toLowerCase()) : false;
  }
}
