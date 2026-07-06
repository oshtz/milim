export function createChatMessageId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return "msg-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}
