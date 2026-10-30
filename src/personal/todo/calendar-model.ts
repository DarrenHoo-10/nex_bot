export const isoDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export const parseDate = (date: string) => new Date(`${date}T12:00:00`);
export function shiftDate(date: string, amount: number, unit = "day") {
  const d = parseDate(date);
  if (unit === "month") {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + amount);
    d.setDate(
      Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()),
    );
  } else d.setDate(d.getDate() + amount * (unit === "week" ? 7 : 1));
  return isoDate(d);
}
export function weekDays(date: string) {
  const d = parseDate(date);
  const start = shiftDate(date, -((d.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => shiftDate(start, i));
}
export function monthDays(date: string) {
  const first = `${date.slice(0, 7)}-01`,
    d = parseDate(first),
    lead = (d.getDay() + 6) % 7;
  const length = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return Array.from({ length: Math.ceil((lead + length) / 7) * 7 }, (_, i) =>
    shiftDate(first, i - lead),
  );
}
export function inPeriod(date: string, anchor: string, period: string) {
  if (!date) return false;
  if (period === "day") return date === anchor;
  if (period === "month") return date.slice(0, 7) === anchor.slice(0, 7);
  const week = weekDays(anchor);
  return date >= week[0] && date <= week[6];
}
export function matchesStatus(status: string, filter: string) {
  return (
    filter === "all" ||
    (filter === "running"
      ? status === "running" || status === "review"
      : status === filter)
  );
}
export function periodTitle(anchor: string, period: string) {
  const d = parseDate(anchor),
    fmt = (date: string) =>
      `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`;
  if (period === "month") return `${d.getFullYear()}年${d.getMonth() + 1}月`;
  if (period === "day")
    return `${fmt(anchor)} · ${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()]}`;
  const week = weekDays(anchor);
  return `${fmt(week[0])} — ${week[0].slice(0, 4) !== week[6].slice(0, 4) ? week[6].slice(0, 4) + "年" : ""}${fmt(week[6])}`;
}
