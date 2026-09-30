"use client";
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from "react";
import Link from "next/link";
import { ArrowUpRightIcon, FocusIcon, MinusIcon, PlusIcon, SearchIcon, NetworkIcon, XIcon } from "lucide-react";
import type { ContactGraphEdge, ContactSummary } from "@/lib/contacts";
import styles from "./contacts-graph.module.css";

type Point = { x: number; y: number };
type Camera = { x: number; y: number; zoom: number };
// Bounded to 300 nodes by the server; local deterministic force layout, no external service.
function layout(people: ContactSummary[], edges: ContactGraphEdge[], width: number, height: number): Map<string, Point> {
 const nodes = people.map((person, i) => ({ id: person.id, x: Math.cos(i * 2.39996) * 18 * Math.sqrt(i + 1), y: Math.sin(i * 2.39996) * 18 * Math.sqrt(i + 1), vx: 0, vy: 0 }));
 const byId = new Map(nodes.map(node => [node.id, node]));
 for (let tick = 0; tick < 150; tick++) {
  const alpha = 1 - tick / 165;
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
   const a = nodes[i], b = nodes[j], dx = a.x - b.x, dy = a.y - b.y, d2 = Math.max(64, dx * dx + dy * dy);
   const force = 1100 * alpha / d2;
   a.vx += dx * force; a.vy += dy * force; b.vx -= dx * force; b.vy -= dy * force;
  }
  for (const edge of edges) {
   const a = byId.get(edge.from), b = byId.get(edge.to); if (!a || !b) continue;
   const dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy)), force = (distance - 115) * .012 * alpha / distance;
   a.vx += dx * force; a.vy += dy * force; b.vx -= dx * force; b.vy -= dy * force;
  }
  for (const node of nodes) { node.vx = (node.vx - node.x * .004 * alpha) * .65; node.vy = (node.vy - node.y * .004 * alpha) * .65; node.x += node.vx; node.y += node.vy; }
 }
 const extentX = Math.max(180, ...nodes.map(node => Math.abs(node.x))), extentY = Math.max(140, ...nodes.map(node => Math.abs(node.y)));
 const fit = Math.min(Math.max(100, width / 2 - 65) / extentX, Math.max(100, height / 2 - 55) / extentY, 1.8);
 return new Map(nodes.map(node => [node.id, { x: node.x * fit, y: node.y * fit }]));
}

export function ContactsGraph({ vault, people, edges, selectedId, onSelect, q, onSearch, group, onGroup, groups, matched, truncated, loading }: {
 vault: string; people: ContactSummary[]; edges: ContactGraphEdge[]; selectedId: string; onSelect: (id: string) => void;
 q: string; onSearch: (q: string) => void; group: string; onGroup: (group: string) => void; groups: string[]; matched: number; truncated: boolean; loading: boolean;
}) {
 const svg = useRef<SVGSVGElement>(null), drag = useRef<{ id?: string; start: Point; original: Point; moved: boolean } | null>(null);
 const [viewport, setViewport] = useState({ width: 1000, height: 500 });
 const initial = useMemo(() => layout(people, edges, viewport.width, viewport.height), [people, edges, viewport]);
 const [positions, setPositions] = useState<Record<string, Point>>({}), [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
 const cameraRef = useRef(camera);
 useEffect(() => { cameraRef.current = camera; }, [camera]);
 const [hovered, setHovered] = useState(""), [edgeId, setEdgeId] = useState("");
 const marker = useId().replace(/:/g, "");
 const byId = new Map(people.map(person => [person.id, person])), degree = new Map<string, number>();
 for (const edge of edges) { degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1); degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1); }
 const focus = hovered || selectedId, adjacent = new Set([focus]);
 for (const edge of edges) { if (edge.from === focus) adjacent.add(edge.to); if (edge.to === focus) adjacent.add(edge.from); }
 const pointOf = (id: string) => positions[id] ?? initial.get(id) ?? { x: 0, y: 0 };
 useEffect(() => {
  const surface = svg.current; if (!surface) return;
  const observer = new ResizeObserver(([entry]) => { const { width, height } = entry.contentRect; if (width && height) setViewport({ width, height }); });
  observer.observe(surface); return () => observer.disconnect();
 }, []);
 const localPoint = (clientX: number, clientY: number): Point => {
  const bounds = svg.current!.getBoundingClientRect();
  return { x: clientX - bounds.left - bounds.width / 2, y: clientY - bounds.top - bounds.height / 2 };
 };
 const zoomBy = (factor: number) => setCamera(current => ({ ...current, zoom: Math.min(4, Math.max(.35, current.zoom * factor)) }));
 useEffect(() => {
  const surface = svg.current; if (!surface) return;
  const wheel = (event: WheelEvent) => {
   event.preventDefault(); const bounds = surface.getBoundingClientRect();
   const p = { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 };
   const current = cameraRef.current, zoom = Math.min(4, Math.max(.35, current.zoom * Math.exp(-event.deltaY * .002)));
   setCamera({ zoom, x: p.x - (p.x - current.x) * zoom / current.zoom, y: p.y - (p.y - current.y) * zoom / current.zoom });
  };
  surface.addEventListener("wheel", wheel, { passive: false }); return () => surface.removeEventListener("wheel", wheel);
 }, []);
 const start = (event: PointerEvent<SVGElement>, id?: string) => {
  if (event.button !== 0) return;
  event.stopPropagation(); svg.current?.setPointerCapture(event.pointerId);
  drag.current = { id, start: localPoint(event.clientX, event.clientY), original: id ? pointOf(id) : camera, moved: false };
 };
 const move = (event: PointerEvent<SVGSVGElement>) => {
  const active = drag.current; if (!active) return;
  const p = localPoint(event.clientX, event.clientY), dx = p.x - active.start.x, dy = p.y - active.start.y;
  if (Math.hypot(dx, dy) > 4) active.moved = true;
  if (active.id) setPositions(current => ({ ...current, [active.id!]: { x: active.original.x + dx / camera.zoom, y: active.original.y + dy / camera.zoom } }));
  else setCamera(current => ({ ...current, x: active.original.x + dx, y: active.original.y + dy }));
 };
 const end = () => { const active = drag.current; drag.current = null; if (active?.id && !active.moved) { setEdgeId(""); onSelect(active.id); } };
 const edge = edges.find(item => item.id === edgeId);
 return <section className={styles.graph} aria-label="人脉图谱">
  <div className={styles.toolbar}><label className={styles.search}><SearchIcon size={15} /><input aria-label="搜索图谱人物" placeholder="搜索姓名、机构、话题" value={q} onChange={event => onSearch(event.target.value)} /></label><select aria-label="图谱人物分组" value={group} onChange={event => onGroup(event.target.value)}><option value="">全部圈层</option>{groups.map(value => <option key={value}>{value}</option>)}</select><span>{loading ? "正在刷新…" : `${people.length} 位人物 · ${edges.length} 条链接`}</span></div>
  <div className={styles.canvas}>
   <svg ref={svg} viewBox={`${-viewport.width / 2} ${-viewport.height / 2} ${viewport.width} ${viewport.height}`} aria-label="人物关系图，可拖拽和缩放" onPointerDown={event => start(event)} onPointerMove={move} onPointerUp={end} onPointerCancel={() => { drag.current = null; }}>
    <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
    <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.zoom})`}>
     {edges.map(item => {
      const a = pointOf(item.from), b = pointOf(item.to), dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy)), offset = 15;
      const path = `M ${a.x + dx / distance * offset} ${a.y + dy / distance * offset} Q ${(a.x + b.x) / 2 - dy * .08} ${(a.y + b.y) / 2 + dx * .08} ${b.x - dx / distance * offset} ${b.y - dy / distance * offset}`;
      const highlighted = item.from === focus || item.to === focus || item.id === edgeId;
      return <g key={item.id} className={styles.edge} data-highlight={highlighted} data-dim={Boolean(focus && !highlighted)} role="button" tabIndex={0} aria-label={`${byId.get(item.from)?.name} → ${byId.get(item.to)?.name}：${item.label}，查看关系来源`} onPointerDown={event => event.stopPropagation()} onClick={() => setEdgeId(item.id)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setEdgeId(item.id); } }}><title>{item.label} · {item.source.title}</title><path className={styles.edgeHit} d={path} /><path className={styles.edgeLine} d={path} markerEnd={item.kind === "mentions" ? undefined : `url(#${marker})`} /></g>;
     })}
     {people.map(person => {
      const p = pointOf(person.id), radius = Math.min(16, 8 + Math.sqrt(degree.get(person.id) ?? 0) * 2);
      return <g key={person.id} transform={`translate(${p.x} ${p.y})`} className={styles.node} data-selected={selectedId === person.id} data-focus={focus === person.id} data-dim={Boolean(focus && !adjacent.has(person.id))} role="button" tabIndex={0} aria-label={`查看 ${person.name} 的人物资料`} onPointerDown={event => start(event, person.id)} onPointerEnter={() => setHovered(person.id)} onPointerLeave={() => setHovered("")} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(person.id); } }}><title>{[person.name, person.company, person.role].filter(Boolean).join(" · ")}</title><circle className={styles.halo} r={radius + 7} /><circle className={styles.dot} r={radius} /><text y={radius + 22} textAnchor="middle">{person.name}</text></g>;
     })}
    </g>
   </svg>
   {!people.length && <div className={styles.empty}><NetworkIcon size={30} /><strong>没有匹配的人物</strong><button onClick={() => { onSearch(""); onGroup(""); }}>清除筛选</button></div>}
   <div className={styles.zoom}><button aria-label="放大图谱" onClick={() => zoomBy(1.25)}><PlusIcon size={17} /></button><span>{Math.round(camera.zoom * 100)}%</span><button aria-label="缩小图谱" onClick={() => zoomBy(.8)}><MinusIcon size={17} /></button><button aria-label="重置图谱布局" onClick={() => { setPositions({}); setCamera({ x: 0, y: 0, zoom: 1 }); }}><FocusIcon size={17} /></button></div>
   {edge && <div className={styles.evidence} role="region" aria-label="人物关系来源"><button className={styles.close} aria-label="关闭关系来源" onClick={() => setEdgeId("")}><XIcon size={15} /></button><small>关系来源</small><strong>{byId.get(edge.from)?.name} → {byId.get(edge.to)?.name}</strong><span>{edge.label}</span><p>{edge.snippet}</p><Link href={`/knowledge?${new URLSearchParams({ vault, note: edge.source.path })}`}>查看来源笔记 · {edge.source.title}<ArrowUpRightIcon size={12} /></Link></div>}
  </div>
  <footer className={styles.footer}><span><i />人物链接<span className={styles.arrow}>→</span>明确关系</span><span>{truncated ? `匹配 ${matched} 位，当前显示前 300 位；请缩小筛选范围` : !edges.length && people.length ? "尚无人物间链接，人物仍可独立查看" : "拖拽人物或画布 · 滚轮缩放 · 点击人物查看档案"}</span></footer>
 </section>;
}
