import { useEffect, useState, type KeyboardEvent } from "react";
import type { SkillOption } from "../../../shared/cli-agents";
import "./skill-picker.css";

function score(value: string, term: string) {
  if (value === term) return 0;
  if (value.startsWith(term)) return 1;
  if (value.includes(term)) return 2;
  let at = -1;
  for (const char of term) {
    at = value.indexOf(char, at + 1);
    if (at < 0) return Infinity;
  }
  return 4;
}

export function matchingSkills(skills: SkillOption[], query: string) {
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
  const terms = normalize(query).trim().replace(/^[/＄$]/, "").split(/\s+/).filter(Boolean);
  return skills.map(skill => {
    const name = normalize(skill.name), description = normalize(skill.description);
    const rank = terms.reduce((total, term) => total + Math.min(score(name, term), 3 + score(description, term)), 0);
    return { skill, rank };
  }).filter(row => Number.isFinite(row.rank)).sort((a, b) => a.rank - b.rank || a.skill.name.localeCompare(b.skill.name)).map(row => row.skill);
}

export function SkillPicker({ load, select, externalQuery }: {
  load: (signal: AbortSignal) => Promise<SkillOption[]>;
  select: (skill: SkillOption) => void;
  externalQuery?: string;
}) {
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState<SkillOption[]>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setSkills(undefined); setError("");
    load(controller.signal).then(rows => { if (!controller.signal.aborted) setSkills(rows); }, cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取技能失败");
    });
    return () => controller.abort();
  }, [load, attempt]);
  const matches = matchingSkills(skills ?? [], externalQuery ?? query);
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-skill-result]"));
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      buttons[0]?.click();
    } else if (buttons.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault(); event.stopPropagation();
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[at < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1) : (at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus();
    }
  }
  return <div className="skill-picker" aria-label="选择技能" onKeyDown={navigate}>
    {externalQuery === undefined && <input type="search" autoFocus aria-label="搜索技能" placeholder="搜索技能" value={query} onChange={e => setQuery(e.target.value)}/>}
    {error ? <div role="alert">{error} <button type="button" onClick={() => setAttempt(attempt + 1)}>重试</button></div>
      : !skills ? <small role="status">正在读取技能…</small>
      : !matches.length ? <small role="status">{skills.length ? "没有匹配的技能" : "暂无可用技能"}</small>
      : <div className="skill-results">{matches.map(skill => <button key={skill.name} data-skill-result type="button" onClick={() => select(skill)}>
        <strong>{skill.name}</strong>{skill.description && <small>{skill.description}</small>}
      </button>)}</div>}
  </div>;
}
