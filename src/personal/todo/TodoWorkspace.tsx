import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowUp,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  FileText,
  Flag,
  ListTodo,
  Loader2,
  PanelLeftOpen,
  Plus,
  Search,
  Send,
  Sparkles,
  Square,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { AgentAvatar } from "../components/AgentAvatar";
import { api, desktop, statuses, type State } from "../api";
import type {
  TodoItem as Item,
  TodoStatus as Status,
} from "../../../shared/personal-todos";
import { GlowButton, GlassSwitch } from "./controls";
import { SoftSelect, DatePicker } from "./pickers";
import {
  isoDate,
  shiftDate,
  weekDays,
  monthDays,
  inPeriod,
  matchesStatus,
  periodTitle,
} from "./calendar-model";
import "./todo.css";
const dateOf = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return isoDate(d);
};
const labels: Record<Status, string> = {
  todo: "未开始",
  running: "进行中",
  review: "待验收",
  done: "已完成",
};
const priorityOptions = ["高", "普通", "低"].map((value) => ({
  value,
  label: value,
  icon: (
    <span
      className={`priority-dot priority-${value === "高" ? "high" : value === "低" ? "low" : "normal"}`}
    />
  ),
}));
function StatusIcon({ status, size = 15 }: { status: Status; size?: number }) {
  return status === "running" ? (
    <Loader2 size={size} />
  ) : status === "review" ? (
    <CircleCheck size={size} />
  ) : status === "done" ? (
    <CheckCheck size={size} />
  ) : (
    <Circle size={size} />
  );
}
function due(date: string) {
  return !date
    ? "无截止日期"
    : date === dateOf()
      ? "今天"
      : date === dateOf(1)
        ? "明天"
        : `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`;
}
function Modal({
  title,
  close,
  children,
  error,
}: {
  title: string;
  close(): void;
  children: ReactNode;
  error?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    ref.current?.querySelector<HTMLInputElement>("input,textarea")?.focus();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className="todo-modal"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="todo-modal-heading">
        <h2>{title}</h2>
        <button className="icon-button" onClick={close} aria-label="关闭弹窗">
          <X size={18} />
        </button>
      </div>
      {error && (
        <p className="todo-error" role="alert">
          {error}
        </p>
      )}
      {children}
    </dialog>
  );
}

export function TodoWorkspace({
  state,
  sidebar,
  overlay,
  dark,
  collapsed,
  onNavigation,
  onOpenAgent,
}: {
  state: State;
  sidebar: ReactNode;
  overlay?: ReactNode;
  dark: boolean;
  collapsed: boolean;
  onNavigation(): void;
  onOpenAgent(id: string): void;
}) {
  const [items, setItems] = useState<Item[]>([]),
    [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("all"),
    [view, setView] = useState("day"),
    [search, setSearch] = useState(""),
    [anchor, setAnchor] = useState(dateOf());
  const [quick, setQuick] = useState(""),
    [toast, setToast] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  type ModalKind = "new" | "edit" | "result" | "revise" | "delete" | null;
  const [modal, setModalState] = useState<ModalKind>(null),
    [editing, setEditing] = useState<Item | null>(null),
    [newId, setNewId] = useState(crypto.randomUUID());
  const inputRef = useRef<HTMLInputElement>(null),
    locked = useRef(false),
    generation = useRef(0),
    mounted = useRef(true);
  const task = items.find((x) => x.id === selected);
  const setModal = (value: ModalKind) => {
    if (locked.current) return;
    setError("");
    if (value === "edit") setEditing(task ?? null);
    if (value === "new") setNewId(crypto.randomUUID());
    setModalState(value);
  };
  const load = useCallback(async () => {
    const seq = ++generation.current;
    try {
      const response = await api<{ items: Item[] }>("todos");
      if (mounted.current && seq === generation.current)
        setItems(response.items);
    } catch (e) {
      if (mounted.current && seq === generation.current)
        setError(e instanceof Error ? e.message : "读取待办失败");
    } finally {
      if (mounted.current && seq === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    void load();
  }, [load, state.sync.cursor]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !modal) setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);
  const perform = async (route: string, data: unknown, message: string) => {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    setError("");
    generation.current++;
    try {
      await api(route, data);
      await load();
      if (mounted.current) setToast(message);
      return true;
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "操作失败，请重试");
      await load();
      return false;
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const action = (item: Item, action: string, feedback?: string) =>
    perform(
      "todos/action",
      {
        id: item.id,
        version: item.version,
        action,
        clientId: crypto.randomUUID(),
        ...(feedback ? { feedback } : {}),
      },
      action === "start"
        ? "已交给 AI"
        : action === "stop"
          ? "正在停止"
          : "已更新待办",
    );
  const update = (id: string, patch: Partial<Item>) => {
    const item = items.find((x) => x.id === id);
    if (!item) return;
    if (patch.status) {
      void action(item, patch.status === "done" ? "complete" : "reopen");
      return;
    }
    void perform("todos/save", { ...item, ...patch }, "已保存待办");
  };
  const choose = (id: string) => setSelected(id);
  const selectPeriod = (value: string) => {
    setView(value);
    setSelected(null);
  };
  const movePeriod = (amount: number) => {
    setAnchor(shiftDate(anchor, amount, view));
    setSelected(null);
  };
  const openDay = (date: string) => {
    setAnchor(date);
    setView("day");
    setSelected(null);
  };
  const newOnDay = (date: string) => {
    setAnchor(date);
    setModal("new");
  };
  const changeStatus = (status: Status) => {
    if (task)
      void action(
        task,
        status === "done"
          ? "complete"
          : status === "running"
            ? "start"
            : task.status === "running"
              ? "stop"
              : "reopen",
      );
  };
  const addQuick = async () => {
    if (!quick.trim()) return;
    const id = crypto.randomUUID();
    if (
      await perform(
        "todos/save",
        {
          id,
          version: 0,
          title: quick.trim(),
          owner: "me",
          date: anchor,
          priority: "普通",
          description: "",
          steps: [],
        },
        "已添加待办",
      )
    ) {
      setQuick("");
      choose(id);
    }
  };
  const ownerName = (id: string) =>
    id === "me"
      ? "我"
      : String(state.bots.find((b) => b.id === id)?.name ?? "已归档 Agent");
  function Avatar({ owner, size = 30 }: { owner: string; size?: number }) {
    return owner === "me" ? (
      <span className="todo-self" style={{ width: size, height: size }}>
        <UserRound size={Math.max(13, size * 0.48)} />
      </span>
    ) : (
      <AgentAvatar
        bot={state.bots.find((b) => b.id === owner)}
        allBots={state.bots}
        size={size}
      />
    );
  }
  const ownerOptions = [
    {
      value: "me",
      label: "我",
      icon: <Avatar owner="me" size={28} />,
      hint: "自己完成",
    },
    ...state.bots.map((b) => ({
      value: String(b.id),
      label: String(b.name),
      icon: <Avatar owner={String(b.id)} size={28} />,
    })),
  ];
  const scoped = items.filter((x) =>
    `${x.title} ${x.description} ${ownerName(x.owner)}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const inRange = scoped.filter((x) => inPeriod(x.date, anchor, view)),
    filtered = inRange.filter((x) => matchesStatus(x.status, filter)),
    unscheduled = scoped.filter(
      (x) => !x.date && matchesStatus(x.status, filter),
    );
  const week = weekDays(anchor),
    month = monthDays(anchor),
    title = "待办",
    groups: Status[] = ["running", "todo", "done"];
  const statusOptions = [
    { id: "all", label: "全部" },
    { id: "running", label: "进行中" },
    { id: "todo", label: "未开始" },
    { id: "done", label: "已完成" },
  ].map((x) => ({
    ...x,
    count: scoped.filter((i) => (!i.date || inPeriod(i.date, anchor, view)) && matchesStatus(i.status, x.id)).length,
  }));
  function Row({ item, card = false }: { item: Item; card?: boolean }) {
    return (
      <div
        className={`todo-row ${card ? "todo-board-card" : ""} ${selected === item.id ? "is-selected" : ""}`}
      >
        <button
          className={`todo-check status-${item.status}`}
          aria-label={`${item.status === "done" ? "重新打开" : "完成"}：${item.title}`}
          disabled={busy || (item.status === "running" && !!item.taskId)}
          onClick={() =>
            update(item.id, {
              status: item.status === "done" ? "todo" : "done",
            })
          }
        >
          <StatusIcon status={item.status} size={18} />
        </button>
        <button
          className="todo-row-content"
          onClick={() => choose(item.id)}
          aria-label={`打开：${item.title}`}
          aria-pressed={selected === item.id}
        >
          <span className="todo-row-title">{item.title}</span>
          <span className="todo-row-meta">
            {item.status === "review" && (
              <span className="review-label">待验收</span>
            )}
            {item.priority === "高" && (
              <span className="todo-priority">
                <Flag size={11} />
                高优先级
              </span>
            )}
            <span
              className={
                item.date && item.date < dateOf() && item.status !== "done"
                  ? "overdue"
                  : ""
              }
            >
              <CalendarDays size={12} />
              {due(item.date)}
            </span>
            {item.steps.length > 0 && (
              <span>
                <ListTodo size={12} />
                {item.steps.filter((s) => s.done).length}/{item.steps.length}
              </span>
            )}
          </span>
        </button>
        <button
          className="todo-row-owner"
          aria-label={`查看${item.title}的负责人`}
          onClick={() => choose(item.id)}
          title={ownerName(item.owner)}
        >
          <Avatar owner={item.owner} size={26} />
          {!card && <span>{ownerName(item.owner)}</span>}
        </button>
      </div>
    );
  }
  return (
    <div
      className="workspace-stage"
      data-shell={desktop?.mode === "client" ? "1" : "0"}
      data-dark={dark ? "1" : "0"}
    >
      <div
        className="app rk-workspace todo-app"
        data-dark={dark ? "1" : "0"}
        data-theme="studio"
        data-left={collapsed ? "closed" : "open"}
        data-right={task ? "open" : "closed"}
        data-page="todo"
        data-mobile-detail={task ? "open" : "closed"}
      >
        {sidebar}
        <main className="todo-main">
          <header>
            <div className="header-side">
              <button
                className="bt-round todo-mobile-nav"
                aria-label="打开导航"
                onClick={onNavigation}
              >
                <PanelLeftOpen size={19} />
              </button>
              <label className="todo-header-search">
                <Search size={15} />
                <input
                  aria-label="搜索待办"
                  placeholder="搜索待办"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
            </div>
            <div className="contact-heading who glass">
              <ListTodo size={16} />
              <strong>统一待办</strong>
            </div>
            <div className="header-actions">
              <GlowButton
                disabled={busy}
                aria-label="新增待办"
                onClick={() => setModal("new")}
              >
                <Plus size={16} />
                <span>新建待办</span>
              </GlowButton>
            </div>
          </header>
          {error && (
            <div role="alert" className="todo-error">
              {error}
              <button
                className="text-button"
                onClick={() => {
                  setError("");
                  void load();
                }}
              >
                重新加载
              </button>
            </div>
          )}
          {loading && (
            <div role="status" className="todo-load-state">
              正在读取待办…
            </div>
          )}
          <section className="todo-content glass" aria-busy={loading || busy}>
            <div className="todo-page-heading">
              <div>
                <h1>
                  {title}
                  <span>{filtered.length + unscheduled.length}</span>
                </h1>
              </div>
              <GlassSwitch
                label="时间视角"
                className="period-switch"
                value={view}
                onChange={selectPeriod}
                items={[
                  { id: "day", label: "日" },
                  { id: "week", label: "周" },
                  { id: "month", label: "月" },
                ]}
              />
            </div>
            <div className="calendar-control-row">
              <div className="calendar-range">
                <h2 aria-live="polite">{periodTitle(anchor, view)}</h2>
                <DatePicker
                  label="选择查看日期"
                  compact
                  clearable={false}
                  value={anchor}
                  onChange={(date) => {
                    setAnchor(date);
                    setSelected(null);
                  }}
                />
              </div>
              <div className="calendar-navigation">
                <button
                  className="calendar-arrow"
                  aria-label={
                    view === "day"
                      ? "上一天"
                      : view === "week"
                        ? "上一周"
                        : "上个月"
                  }
                  onClick={() => movePeriod(-1)}
                >
                  <ArrowLeft size={14} />
                </button>
                <button
                  className="calendar-today"
                  onClick={() => {
                    setAnchor(dateOf());
                    setSelected(null);
                  }}
                >
                  今天
                </button>
                <button
                  className="calendar-arrow"
                  aria-label={
                    view === "day"
                      ? "下一天"
                      : view === "week"
                        ? "下一周"
                        : "下个月"
                  }
                  onClick={() => movePeriod(1)}
                >
                  <ChevronRight size={17} />
                </button>
              </div>
            </div>
            <div className="todo-toolbar">
              <GlassSwitch
                label="状态筛选"
                className="status-switch"
                value={filter}
                onChange={setFilter}
                items={statusOptions}
              />
            </div>
            <div
              className={`todo-list-scroll calendar-scroll view-${view}`}
              key={`${view}-${anchor}-${filter}`}
            >
              {view === "day" && (filtered.length > 0 || unscheduled.length === 0) && (
                <div className="day-agenda">
                  {filtered.length === 0 ? (
                    <div className="todo-empty">
                      <CalendarDays size={30} />
                      <h3>
                        {search
                          ? "没有找到相关待办"
                          : "这一天暂时没有匹配的待办"}
                      </h3>
                      <button
                        className="text-button"
                        onClick={() => newOnDay(anchor)}
                      >
                        安排一件事 <Plus size={13} />
                      </button>
                    </div>
                  ) : (
                    groups.map((status) => {
                      const list = filtered.filter((x) =>
                        status === "running"
                          ? x.status === "running" || x.status === "review"
                          : x.status === status,
                      );
                      return (
                        list.length > 0 && (
                          <section key={status} className="todo-group">
                            <div
                              className={`todo-group-heading status-${status}`}
                            >
                              <StatusIcon status={status} />
                              <h2>{labels[status]}</h2>
                              <span>{list.length}</span>
                            </div>
                            {list.map((item) => (
                              <Row key={item.id} item={item} />
                            ))}
                          </section>
                        )
                      );
                    })
                  )}
                </div>
              )}
              {view === "week" && (
                <div className="calendar-week" aria-label="本周待办">
                  {week.map((day, index) => {
                    const dayItems = filtered.filter((x) => x.date === day);
                    return (
                      <section
                        className={`week-day ${day === dateOf() ? "is-today" : ""}`}
                        key={day}
                      >
                        <div className="week-day-heading">
                          <button
                            className="week-date"
                            onClick={() => openDay(day)}
                            aria-label={`查看${day}`}
                          >
                            <span>
                              {
                                [
                                  "周一",
                                  "周二",
                                  "周三",
                                  "周四",
                                  "周五",
                                  "周六",
                                  "周日",
                                ][index]
                              }
                            </span>
                            <strong>{Number(day.slice(8))}</strong>
                            {day === dateOf() && <i />}
                          </button>
                          <button
                            className="day-add"
                            onClick={() => newOnDay(day)}
                            aria-label={`在${day}添加待办`}
                          >
                            <Plus size={13} />
                          </button>
                        </div>
                        <div className="week-events">
                          {dayItems.map((item) => (
                            <button
                              key={item.id}
                              className={`calendar-task status-${item.status} ${selected === item.id ? "is-selected" : ""}`}
                              onClick={() => choose(item.id)}
                              aria-label={`打开：${item.title}`}
                            >
                              <span className="calendar-task-heading">
                                <StatusIcon status={item.status} size={13} />
                                <small>
                                  {item.status === "review"
                                    ? "待验收"
                                    : labels[item.status]}
                                </small>
                              </span>
                              <strong>{item.title}</strong>
                              <span className="calendar-task-footer">
                                <Avatar owner={item.owner} size={23} />
                                {item.priority === "高" && <Flag size={12} />}
                              </span>
                            </button>
                          ))}
                          {!dayItems.length && (
                            <span className="week-free">—</span>
                          )}
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}
              {view === "month" && (
                <div className="calendar-month" aria-label="本月待办">
                  <div className="month-weekdays">
                    {["一", "二", "三", "四", "五", "六", "日"].map((day) => (
                      <span key={day}>周{day}</span>
                    ))}
                  </div>
                  <div className="month-grid">
                    {month.map((day) => {
                      const dayItems = scoped.filter(
                        (x) =>
                          x.date === day && matchesStatus(x.status, filter),
                      );
                      return (
                        <section
                          key={day}
                          className={`month-day ${day.slice(0, 7) !== anchor.slice(0, 7) ? "outside-month" : ""} ${day === dateOf() ? "is-today" : ""}`}
                        >
                          <div className="month-day-heading">
                            <button
                              className="month-date"
                              onClick={() => openDay(day)}
                              aria-label={`查看${day}`}
                            >
                              <span>
                                {Number(day.slice(8)) === 1
                                  ? `${Number(day.slice(5, 7))}月1日`
                                  : Number(day.slice(8))}
                              </span>
                            </button>
                            <button
                              className="day-add"
                              onClick={() => newOnDay(day)}
                              aria-label={`在${day}添加待办`}
                            >
                              <Plus size={12} />
                            </button>
                          </div>
                          <div className="month-events">
                            {dayItems.slice(0, 1).map((item) => (
                              <button
                                key={item.id}
                                className={`month-event status-${item.status}`}
                                onClick={() => choose(item.id)}
                                title={`${item.title} · ${labels[item.status]}`}
                                aria-label={`打开：${item.title}`}
                              >
                                <i />
                                <span>{item.title}</span>
                              </button>
                            ))}
                            {dayItems.length > 1 && (
                              <button
                                className="month-more"
                                aria-label={`查看${day}其余${dayItems.length - 1}项待办`}
                                onClick={() => openDay(day)}
                              >
                                +{dayItems.length - 1}
                              </button>
                            )}
                          </div>
                          {dayItems.length > 0 && (
                            <button
                              className="month-mobile-count"
                              onClick={() => openDay(day)}
                              aria-label={`查看${day}的${dayItems.length}项待办`}
                            >
                              {dayItems.length} 项
                            </button>
                          )}
                        </section>
                      );
                    })}
                  </div>
                </div>
              )}
              {unscheduled.length > 0 && (
                <details className="unscheduled-tray" open>
                  <summary>
                    <span>
                      <ListTodo size={14} />
                      未安排<small>{unscheduled.length}</small>
                    </span>
                    <ChevronDown size={15} />
                  </summary>
                  <div>
                    {unscheduled.map((item) => (
                      <Row key={item.id} item={item} />
                    ))}
                  </div>
                </details>
              )}
            </div>
            <form
              className="todo-quick"
              onSubmit={(e) => {
                e.preventDefault();
                addQuick();
              }}
            >
              <button
                type="button"
                className="icon-button"
                aria-label="填写完整待办"
                onClick={() => setModal("new")}
              >
                <Plus size={20} />
              </button>
              <input
                ref={inputRef}
                placeholder={`添加待办 · ${due(anchor)}`}
                aria-label="快速添加待办"
                value={quick}
                onChange={(e) => setQuick(e.target.value)}
                maxLength={120}
              />
              <button
                className="todo-send"
                type="submit"
                disabled={!quick.trim()}
                aria-label="添加待办"
              >
                <ArrowUp size={17} />
              </button>
            </form>
          </section>
        </main>
        {task && (
          <aside className="todo-detail glass" aria-label="待办详情">
            <div className="todo-detail-top">
              <span className={`todo-status-pill status-${task.status}`}>
                <StatusIcon status={task.status} />
                {labels[task.status]}
              </span>
              <div>
                <button
                  className="icon-button"
                  aria-label="删除待办"
                  onClick={() => setModal("delete")}
                >
                  <Trash2 size={15} />
                </button>
                <button
                  className="icon-button"
                  aria-label="关闭详情"
                  onClick={() => setSelected(null)}
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="todo-detail-scroll">
              <button
                disabled={busy || (task.status === "running" && !!task.taskId)}
                className="todo-edit-title"
                onClick={() => setModal("edit")}
                title="编辑待办"
              >
                <h2>{task.title}</h2>
              </button>
              <div className="todo-properties">
                <div>
                  <span>
                    <UserRound size={14} />
                    负责人
                  </span>
                  <SoftSelect
                    label="负责人"
                    options={ownerOptions}
                    value={task.owner}
                    disabled={
                      busy || (task.status === "running" && !!task.taskId)
                    }
                    onChange={(owner) => update(task.id, { owner })}
                  />
                </div>
                <div>
                  <span>
                    <CalendarDays size={14} />
                    截止日期
                  </span>
                  <DatePicker
                    label="截止日期"
                    disabled={
                      busy || (task.status === "running" && !!task.taskId)
                    }
                    value={task.date}
                    onChange={(date) => update(task.id, { date })}
                  />
                </div>
                <div>
                  <span>
                    <Flag size={14} />
                    优先级
                  </span>
                  <SoftSelect
                    label="优先级"
                    disabled={
                      busy || (task.status === "running" && !!task.taskId)
                    }
                    options={priorityOptions}
                    value={task.priority}
                    onChange={(priority) => update(task.id, { priority })}
                  />
                </div>
              </div>

              <section className="todo-description">
                <div className="todo-section-title">
                  <h3>完成要求</h3>
                  <button
                    disabled={
                      busy || (task.status === "running" && !!task.taskId)
                    }
                    className="text-button"
                    onClick={() => setModal("edit")}
                  >
                    编辑
                  </button>
                </div>
                <p>{task.description || "还没有添加说明"}</p>
              </section>
              {task.steps.length > 0 && (
                <section className="todo-checklist">
                  <div className="todo-section-title">
                    <h3>步骤</h3>
                    <span>
                      {task.steps.filter((s) => s.done).length} /{" "}
                      {task.steps.length}
                    </span>
                  </div>
                  {task.steps.map((step, i) => (
                    <label className={step.done ? "is-done" : ""} key={i}>
                      <input
                        type="checkbox"
                        disabled={
                          busy || (task.status === "running" && !!task.taskId)
                        }
                        checked={step.done}
                        onChange={() =>
                          update(task.id, {
                            steps: task.steps.map((s, n) =>
                              n === i ? { ...s, done: !s.done } : s,
                            ),
                          })
                        }
                      />
                      <span>{step.text}</span>
                    </label>
                  ))}
                </section>
              )}
              {(task.status === "review" || task.status === "done") &&
                task.result && (
                  <section className="todo-delivery">
                    <div className="todo-delivery-by">
                      <Avatar owner={task.owner} size={30} />
                      <div>
                        <strong>{ownerName(task.owner)}</strong>
                        <span>
                          {task.status === "done"
                            ? "已确认完成"
                            : "已完成，等你看看"}
                        </span>
                      </div>
                      <Sparkles size={15} />
                    </div>
                    <button
                      className="todo-result"
                      onClick={() => setModal("result")}
                    >
                      <span className="todo-file-icon">
                        <FileText size={20} />
                      </span>
                      <span>
                        <strong>
                          {task.result?.split("\n")[0] || task.title}
                        </strong>
                        <small>查看交付内容</small>
                      </span>
                      <ChevronRight size={16} />
                    </button>
                  </section>
                )}
              {task.status === "running" && task.taskId && (
                <section className="todo-running">
                  <span>
                    <Loader2 size={15} />
                    {statuses[task.taskStatus ?? "running"] ?? "进行中"}
                  </span>
                  <button
                    className="text-button"
                    onClick={() => onOpenAgent(task.owner)}
                  >
                    打开对话与审批 <ChevronRight size={13} />
                  </button>
                </section>
              )}
              {task.status === "todo" &&
                task.taskStatus &&
                ["failed", "rejected", "cancelled"].includes(
                  task.taskStatus,
                ) && (
                  <section className="todo-running">
                    <span>{statuses[task.taskStatus]}</span>
                    <p>{task.result}</p>
                  </section>
                )}
              <details className="todo-activity-fold" key={task.id}>
                <summary>
                  <span>
                    动态记录 <small>{task.log.length}</small>
                  </span>
                  <ChevronDown size={14} />
                </summary>
                <section className="todo-activity">
                  {task.log.map((log, i) => (
                    <div key={i}>
                      <span className="todo-timeline-dot" />
                      <div>
                        <p>{log}</p>
                        <small>{i === 0 ? "最近更新" : "此前"}</small>
                      </div>
                    </div>
                  ))}
                </section>
              </details>
            </div>
            <footer className="todo-detail-footer">
              {task.status === "review" ? (
                <>
                  <button
                    className="todo-secondary"
                    onClick={() => setModal("revise")}
                  >
                    继续修改
                  </button>
                  <GlowButton
                    disabled={busy}
                    className=""
                    onClick={() => changeStatus("done")}
                  >
                    <Check size={15} />
                    确认完成
                  </GlowButton>
                </>
              ) : task.status === "running" && !task.taskId ? (
                <>
                  <button
                    className="todo-secondary"
                    disabled={busy}
                    onClick={() => void action(task, "stop")}
                  >
                    暂停处理
                  </button>
                  <GlowButton
                    disabled={busy}
                    onClick={() => changeStatus("done")}
                  >
                    <Check size={15} />
                    标记完成
                  </GlowButton>
                </>
              ) : task.status === "running" ? (
                <button
                  className="todo-secondary todo-full"
                  onClick={() => changeStatus("todo")}
                >
                  <Square size={13} />
                  停止执行
                </button>
              ) : task.status === "done" ? (
                <button
                  className="todo-secondary todo-full"
                  onClick={() => changeStatus("todo")}
                >
                  重新打开
                </button>
              ) : task.owner === "me" ? (
                <>
                  <button
                    className="todo-secondary"
                    disabled={busy}
                    onClick={() => void action(task, "begin")}
                  >
                    开始处理
                  </button>
                  <GlowButton
                    disabled={busy}
                    onClick={() => changeStatus("done")}
                  >
                    <Check size={15} />
                    标记完成
                  </GlowButton>
                </>
              ) : (
                <GlowButton
                  disabled={busy}
                  className="todo-full"
                  onClick={() => changeStatus("running")}
                >
                  <Sparkles size={15} />
                  交给{ownerName(task.owner)}
                </GlowButton>
              )}
            </footer>
          </aside>
        )}
        {toast && (
          <div role="status" className="todo-toast">
            <CircleCheck size={16} />
            {toast}
          </div>
        )}
        {(modal === "new" || modal === "edit") && (
          <Modal
            error={error}
            title={modal === "new" ? "新建待办" : "编辑待办"}
            close={() => setModal(null)}
          >
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                const fields = {
                  id: modal === "edit" ? editing!.id : newId,
                  version: modal === "edit" ? editing!.version : 0,
                  title: String(data.get("title")).trim(),
                  description: String(data.get("description")),
                  owner: String(data.get("owner")),
                  date: String(data.get("date")),
                  priority: String(data.get("priority")),
                  steps: modal === "edit" ? editing!.steps : [],
                };
                if (await perform("todos/save", fields, "已保存待办")) {
                  setModalState(null);
                  choose(fields.id);
                }
              }}
            >
              <fieldset className="todo-form-fieldset" disabled={busy}>
                <label className="todo-form-field">
                  要做什么
                  <input
                    autoFocus
                    name="title"
                    aria-label="待办标题"
                    placeholder="例如：整理这周的项目进展"
                    defaultValue={modal === "edit" ? editing?.title : ""}
                    required
                    maxLength={120}
                  />
                </label>
                <label className="todo-form-field">
                  完成要求
                  <textarea
                    name="description"
                    aria-label="完成要求"
                    placeholder="希望得到什么结果？"
                    rows={4}
                    maxLength={4000}
                    defaultValue={modal === "edit" ? editing?.description : ""}
                  />
                </label>
                <div className="todo-form-row">
                  <div className="todo-form-field">
                    <span>交给谁</span>
                    <SoftSelect
                      label="交给谁"
                      name="owner"
                      options={ownerOptions}
                      defaultValue={modal === "edit" ? editing?.owner : "me"}
                      disabled={
                        modal === "edit" && editing?.status === "running" && !!editing.taskId
                      }
                    />
                  </div>
                  <div className="todo-form-field">
                    <span>截止日期</span>
                    <DatePicker
                      label="截止日期"
                      name="date"
                      defaultValue={modal === "edit" ? editing?.date : anchor}
                    />
                  </div>
                  <div className="todo-form-field">
                    <span>优先级</span>
                    <SoftSelect
                      label="优先级"
                      name="priority"
                      options={priorityOptions}
                      defaultValue={
                        modal === "edit" ? editing?.priority : "普通"
                      }
                    />
                  </div>
                </div>
                <div className="todo-modal-actions">
                  <button
                    type="button"
                    className="todo-secondary"
                    onClick={() => setModal(null)}
                  >
                    取消
                  </button>
                  <GlowButton type="submit">
                    {modal === "new" ? "添加待办" : "保存修改"}
                  </GlowButton>
                </div>
              </fieldset>
            </form>
          </Modal>
        )}
        {modal === "result" && task && (
          <Modal error={error} title="交付内容" close={() => setModal(null)}>
            <pre className="todo-result-document">{task.result}</pre>
            {task.status === "review" && (
              <div className="todo-modal-actions">
                <button
                  className="todo-secondary"
                  onClick={() => {
                    setModal("revise");
                  }}
                >
                  继续修改
                </button>
                <GlowButton
                  disabled={busy}
                  className=""
                  onClick={async () => {
                    if (task && (await action(task, "complete")))
                      setModalState(null);
                  }}
                >
                  确认完成
                </GlowButton>
              </div>
            )}
          </Modal>
        )}
        {modal === "revise" && task && (
          <Modal error={error} title="继续修改" close={() => setModal(null)}>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const message = String(
                  new FormData(e.currentTarget).get("message"),
                ).trim();
                if (message && task && (await action(task, "start", message)))
                  setModalState(null);
              }}
            >
              <fieldset className="todo-form-fieldset" disabled={busy}>
                <label className="todo-form-field">
                  告诉 AI 要调整什么
                  <textarea
                    autoFocus
                    required
                    name="message"
                    maxLength={2000}
                    placeholder="例如：补充每项工作的下一步安排"
                    rows={4}
                  />
                </label>
                <div className="todo-modal-actions">
                  <GlowButton disabled={busy} className="">
                    <Send size={14} />
                    提交修改要求
                  </GlowButton>
                </div>
              </fieldset>
            </form>
          </Modal>
        )}
        {modal === "delete" && task && (
          <Modal
            error={error}
            title="删除这条待办？"
            close={() => setModal(null)}
          >
            <p className="todo-modal-copy">{task.title}</p>
            <div className="todo-modal-actions">
              <button className="todo-secondary" onClick={() => setModal(null)}>
                取消
              </button>
              <GlowButton
                disabled={busy}
                className=""
                onClick={async () => {
                  if (await action(task, "delete")) {
                    setSelected(null);
                    setModalState(null);
                  }
                }}
              >
                删除
              </GlowButton>
            </div>
          </Modal>
        )}
        {overlay}
      </div>
    </div>
  );
}
