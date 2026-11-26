import fs from "node:fs";

export const silentEditReply = (text) => /^(?:\[edited\]|<no-reply\s*\/>)?$/i.test(text.trim());
export const messageText = (message) => typeof message?.content === "string" ? message.content : (Array.isArray(message?.content) ? message.content : []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
const deliveryMessage = (message) => /^(?:<pipi-message from="[^"]+" title="[^"]*" agent="[^"]*" status="[^"]*">[\s\S]*?<\/pipi-message>\s*)+$/.test(messageText(message).replace(/^<pipi-persona\b[^>]*>[\s\S]*?<\/pipi-persona>\s*/, "").trim());
export const backgroundDelivery = (message) => deliveryMessage(message) && !messageText(message).includes('<pipi-message from="user"');
export const messageKey = (message) => JSON.stringify([message.timestamp, messageText(message)]);
const lastStep = (message) => message.content.findLastIndex((block) => block.type === "toolCall" || block.type === "thinking");
const answerText = (message) => messageText({ content: message.content.slice(lastStep(message) + 1) });

export function readEdits(file) {
  if (!file) return [];
  try {
    return fs.readFileSync(`${file}.pipi-edits.jsonl`, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try { const entry = JSON.parse(line); return entry.type === "message_edit" ? [entry] : []; } catch { return []; }
    });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function editableMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user" && !backgroundDelivery(message)) return undefined;
    if (message.role === "assistant" && message.stopReason === "stop" && answerText(message).trim() && !silentEditReply(answerText(message))) return message;
  }
}

export function appendEdit(file, message, content, at = Date.now(), turnAt, userAt) {
  const entry = { type: "message_edit", key: messageKey(message), original: answerText(message), originalAt: message.timestamp, content, at, turnAt, userAt };
  const fd = fs.openSync(`${file}.pipi-edits.jsonl`, "a+", 0o600);
  try {
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(1);
    if (size) fs.readSync(fd, tail, 0, 1, size - 1);
    fs.writeSync(fd, `${size && tail[0] !== 10 ? "\n" : ""}${JSON.stringify(entry)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return entry;
}

export function editedMessage(message, edits) {
  if (message?.role !== "assistant") return message;
  const key = messageKey(message);
  const history = edits.filter((edit) => edit.key === key);
  if (!history.length) return { ...message, editKey: key };
  const versions = [{ content: history[0].original, at: history[0].originalAt }, ...history.map((edit) => ({ content: edit.content, at: edit.at }))];
  let first = true;
  const step = lastStep(message);
  const content = message.content.flatMap((block, index) => {
    if (block.type !== "text" || index <= step) return [block];
    if (!first) return [];
    first = false;
    return [{ ...block, text: versions.at(-1).content }];
  });
  return { ...message, content, editKey: key, versions };
}

export function editSnapshot(messages, edits) {
  let userAt;
  return messages.map((message) => {
    if (message?.role === "user") userAt = message.timestamp;
    if (message?.role !== "assistant") return message;
    const editTurn = edits.some((edit) => edit.userAt === userAt && edit.turnAt !== undefined && message.timestamp >= edit.turnAt);
    const updated = editedMessage(message, edits);
    if (!editTurn) return updated;
    return { ...updated, silentEdit: true, content: updated.content.map((block) => block.type === "text" && silentEditReply(block.text) ? { ...block, text: "" } : block) };
  });
}
