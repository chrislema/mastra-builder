export function currentWorkerCompatibilityDate(now: Date = new Date()) {
  return now.toISOString().slice(0, 10);
}
