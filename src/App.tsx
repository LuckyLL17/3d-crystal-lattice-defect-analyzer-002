import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Grid, Html, Line, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

type DefectType = 'vacancy' | 'substitution' | 'dislocation';
type AtomPoint = { key: string; x: number; y: number; z: number; defect?: 'vacancy' | 'substitution' | 'normal' };
const colors = { host: '#64c9e1', substitution: '#efb863', vacancy: '#ef7e83', bond: '#4b8190' };
const SPACING = 1.25; // 相邻晶格点在场景中的间距（场景单位）
const LATTICE_A = 4.05; // 侧栏公示的晶格常数（Å），仅用于几何换算展示
const PICK_COLORS = ['#ffd54a', '#7dffb0', '#7db4ff']; // P1 / P2 / P3

function buildAtoms(cells: number, defect: DefectType): AtomPoint[] {
  const atoms: AtomPoint[] = [];
  for (let x = 0; x < cells; x += 1) for (let y = 0; y < cells; y += 1) for (let z = 0; z < cells; z += 1) {
    const key = `${x}-${y}-${z}`;
    if (defect === 'vacancy' && x === 1 && y === 1 && z === 1) continue;
    if (defect === 'substitution' && x === 1 && y === 1 && z === 1) atoms.push({ key, x, y, z, defect: 'substitution' });
    else atoms.push({ key, x, y, z, defect: 'normal' });
  }
  if (defect === 'dislocation') return atoms.filter(atom => !(atom.x === 2 && atom.y === 0 && atom.z === 2));
  return atoms;
}

function atomPosition(atom: AtomPoint, cells: number): THREE.Vector3 {
  const offset = ((cells - 1) / 2) * SPACING;
  return new THREE.Vector3(atom.x * SPACING - offset, atom.y * SPACING - offset, atom.z * SPACING - offset);
}

function buildBonds(atoms: AtomPoint[], positions: Map<string, THREE.Vector3>): [THREE.Vector3, THREE.Vector3][] {
  const list: [THREE.Vector3, THREE.Vector3][] = [];
  atoms.forEach(atom => {
    const origin = positions.get(atom.key)!;
    const xNeighbor = atoms.find(item => item.x === atom.x + 1 && item.y === atom.y && item.z === atom.z);
    if (xNeighbor) list.push([origin, positions.get(xNeighbor.key)!]);
    const zNeighbor = atoms.find(item => item.x === atom.x && item.y === atom.y && item.z === atom.z + 1);
    if (zNeighbor) list.push([origin, positions.get(zNeighbor.key)!]);
  });
  return list;
}

/* ------------------------------------------------------------------ */
/* 选择状态机：empty → one → two(可测距离) → three(可测夹角)          */
/* ------------------------------------------------------------------ */
type SelectionAction =
  | { type: 'pick'; key: string }      // 拾取原子
  | { type: 'cancelLast' }            // 点击空白：取消最后一点
  | { type: 'reset' }                 // 重置全部选择
  | { type: 'retain'; valid: Set<string> }; // 模型/晶胞改变后清理失效点

function selectionReducer(state: string[], action: SelectionAction): string[] {
  switch (action.type) {
    case 'pick': {
      const index = state.indexOf(action.key);
      if (index >= 0) return state.filter(key => key !== action.key); // 再点已选原子：取消该点
      if (state.length >= 3) return [action.key];                     // 已满 3 点：以新原子开始新一轮
      return [...state, action.key];
    }
    case 'cancelLast':
      return state.slice(0, -1);
    case 'reset':
      return [];
    case 'retain': {
      const next = state.filter(key => action.valid.has(key));
      return next.length === state.length ? state : next; // 无失效点时保持引用，跳过重渲染
    }
    default:
      return state;
  }
}

/* ------------------------------------------------------------------ */
/* 统一射线拾取：原子 mesh 全部挂在同一 group，点击成立时只做一次     */
/* raycaster 检测；pointerdown/up 位移超阈值即判定为旋转拖拽，不误选  */
/* ------------------------------------------------------------------ */
function UnifiedAtomPicker({ atomGroup, onPick, onCancelLast }: { atomGroup: React.RefObject<THREE.Group | null>; onPick: (key: string) => void; onCancelLast: () => void }) {
  const { camera, raycaster, gl } = useThree();

  useEffect(() => {
    const dom = gl.domElement;
    dom.style.cursor = 'grab';
    const ndc = new THREE.Vector2();
    const down = { x: 0, y: 0, active: false };
    const DRAG_PX = 6; // 点击与拖拽的位移阈值
    let hoverFrame = 0;

    const raycastAt = (clientX: number, clientY: number): string | null => {
      const rect = dom.getBoundingClientRect();
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      // 对整组原子做一次统一射线检测，而非逐原子事件
      const hits = raycaster.intersectObjects(atomGroup.current?.children ?? [], false);
      return hits.length > 0 ? (hits[0].object.userData.atomKey as string) : null;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return; // 仅主键拾取，其余交给 OrbitControls
      down.active = true;
      down.x = event.clientX;
      down.y = event.clientY;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!down.active || event.button !== 0) return;
      down.active = false;
      // 点击/拖拽竞态：松手时位移超过阈值视为旋转/缩放拖拽，放弃拾取
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > DRAG_PX) return;
      const key = raycastAt(event.clientX, event.clientY);
      if (key) onPick(key);
      else onCancelLast(); // 点到原子以外（空白/晶面/网格）：取消最后一点
    };
    const onPointerCancel = () => { down.active = false; };
    const onPointerMove = (event: PointerEvent) => {
      if (event.buttons !== 0) { dom.style.cursor = 'grabbing'; return; }
      cancelAnimationFrame(hoverFrame);
      hoverFrame = requestAnimationFrame(() => { dom.style.cursor = raycastAt(event.clientX, event.clientY) ? 'pointer' : 'grab'; });
    };

    dom.addEventListener('pointerdown', onPointerDown);
    dom.addEventListener('pointerup', onPointerUp);
    dom.addEventListener('pointercancel', onPointerCancel);
    dom.addEventListener('pointermove', onPointerMove);
    return () => {
      dom.removeEventListener('pointerdown', onPointerDown);
      dom.removeEventListener('pointerup', onPointerUp);
      dom.removeEventListener('pointercancel', onPointerCancel);
      dom.removeEventListener('pointermove', onPointerMove);
      cancelAnimationFrame(hoverFrame);
    };
  }, [gl, camera, raycaster, atomGroup, onPick, onCancelLast]);

  return null;
}

/* ------------------------------------------------------------------ */
/* 测量覆盖层：选中光环、序号徽章、两点连线、三点夹角弧与数值标签     */
/* ------------------------------------------------------------------ */
function angleArcGeometry(vertex: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, radius: number) {
  const v1 = a.clone().sub(vertex).normalize();
  const v2 = b.clone().sub(vertex).normalize();
  const angle = v1.angleTo(v2);
  let normal = new THREE.Vector3().crossVectors(v1, v2);
  if (normal.lengthSq() < 1e-8) normal = new THREE.Vector3(0, 1, 0); // 三点共线兜底
  normal.normalize();
  const segments = 28;
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const dir = v1.clone().applyAxisAngle(normal, (angle * i) / segments);
    points.push(vertex.clone().add(dir.multiplyScalar(radius)));
  }
  const bisector = v1.clone().applyAxisAngle(normal, angle / 2).multiplyScalar(radius * 1.85);
  return { points, labelPosition: vertex.clone().add(bisector) };
}

function MeasureLabel({ position, className, color, children }: { position: THREE.Vector3; className: string; color?: string; children: React.ReactNode }) {
  return <Html position={position} center zIndexRange={[20, 0]} wrapperClass="measure-label-wrap"><span className={className} style={color ? { borderColor: color, color } : undefined}>{children}</span></Html>;
}

function MeasurementOverlay({ selected, positions }: { selected: string[]; positions: Map<string, THREE.Vector3> }) {
  const pts = selected.map(key => positions.get(key)).filter((p): p is THREE.Vector3 => Boolean(p));
  const arc = useMemo(
    () => (pts.length === 3 ? angleArcGeometry(pts[1], pts[0], pts[2], 0.55) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, positions],
  );

  return (
    <group>
      {pts.map((point, index) => (
        <group key={`pick-${selected[index]}`}>
          <mesh position={point}>
            <sphereGeometry args={[0.34, 20, 14]} />
            <meshBasicMaterial color={PICK_COLORS[index]} transparent opacity={0.22} depthWrite={false} />
          </mesh>
          <MeasureLabel position={point.clone().add(new THREE.Vector3(0, 0.46, 0))} className="pick-badge" color={PICK_COLORS[index]}>P{index + 1}</MeasureLabel>
        </group>
      ))}
      {pts.length >= 2 && (
        <>
          <Line points={[pts[0], pts[1]]} color={PICK_COLORS[0]} lineWidth={2} transparent opacity={0.9} />
          <MeasureLabel position={pts[0].clone().lerp(pts[1], 0.5)} className="measure-tag">{pts[0].distanceTo(pts[1]).toFixed(3)}</MeasureLabel>
        </>
      )}
      {pts.length === 3 && (
        <>
          <Line points={[pts[1], pts[2]]} color={PICK_COLORS[2]} lineWidth={2} transparent opacity={0.9} />
          <MeasureLabel position={pts[1].clone().lerp(pts[2], 0.5)} className="measure-tag">{pts[1].distanceTo(pts[2]).toFixed(3)}</MeasureLabel>
          {arc && (
            <>
              <Line points={arc.points} color={PICK_COLORS[1]} lineWidth={1.6} transparent opacity={0.95} />
              <MeasureLabel position={arc.labelPosition} className="angle-tag" color={PICK_COLORS[1]}>
                {(Math.acos(Math.min(1, Math.max(-1, pts[0].clone().sub(pts[1]).normalize().dot(pts[2].clone().sub(pts[1]).normalize())))) * 180 / Math.PI).toFixed(1)}°
              </MeasureLabel>
            </>
          )}
        </>
      )}
    </group>
  );
}

function DefectScene({ atoms, positions, bonds, defect, showBonds, planeOpacity, selectedKeys, onPick, onCancelLast }: {
  atoms: AtomPoint[];
  positions: Map<string, THREE.Vector3>;
  bonds: [THREE.Vector3, THREE.Vector3][];
  defect: DefectType;
  showBonds: boolean;
  planeOpacity: number;
  selectedKeys: string[];
  onPick: (key: string) => void;
  onCancelLast: () => void;
}) {
  const atomGroup = useRef<THREE.Group>(null);

  return (
    <Canvas shadows camera={{ position: [8, 6, 8], fov: 38 }}>
      <color attach="background" args={['#09151d']} />
      <ambientLight intensity={1.25} />
      <directionalLight position={[5, 8, 5]} intensity={2.3} castShadow />
      <pointLight position={[-4, 2, 3]} color="#5fd4ee" intensity={12} distance={12} />
      <UnifiedAtomPicker atomGroup={atomGroup} onPick={onPick} onCancelLast={onCancelLast} />
      <group rotation={[.15, -.35, 0]}>
        {showBonds && bonds.map((bond, index) => <Line key={index} points={bond} color={colors.bond} lineWidth={1.2} transparent opacity={.65} />)}
        <group ref={atomGroup}>
          {atoms.map(atom => {
            const position = positions.get(atom.key)!;
            const isSubstitution = atom.defect === 'substitution';
            const pickIndex = selectedKeys.indexOf(atom.key);
            const picked = pickIndex >= 0;
            return (
              <mesh key={atom.key} position={position} castShadow userData={{ atomKey: atom.key }}>
                <sphereGeometry args={[isSubstitution ? .3 : .2, 18, 12]} />
                <meshStandardMaterial
                  color={isSubstitution ? colors.substitution : colors.host}
                  emissive={picked ? PICK_COLORS[pickIndex] : isSubstitution ? colors.substitution : '#000000'}
                  emissiveIntensity={picked ? .8 : isSubstitution ? .35 : 0}
                />
              </mesh>
            );
          })}
        </group>
        <MeasurementOverlay selected={selectedKeys} positions={positions} />
        {defect === 'vacancy' && <mesh position={[0, 0, 0]}><sphereGeometry args={[.35, 16, 12]} /><meshBasicMaterial color={colors.vacancy} transparent opacity={.26} wireframe /></mesh>}
        {defect === 'dislocation' && <Line points={[new THREE.Vector3(-1.9, -1.9, 0), new THREE.Vector3(-.65, -1.9, 0), new THREE.Vector3(-.65, -.65, 0), new THREE.Vector3(.65, -.65, 0), new THREE.Vector3(.65, .65, 0), new THREE.Vector3(1.9, .65, 0)]} color="#f08d87" lineWidth={4} />}
      </group>
      <mesh rotation={[0, 0, 0]} position={[0, 0, 0]}><planeGeometry args={[5.6, 5.6]} /><meshBasicMaterial color="#69cde2" transparent opacity={planeOpacity} side={THREE.DoubleSide} /></mesh>
      <Grid args={[8, 8]} cellSize={1.25} sectionSize={2.5} cellColor="#326778" sectionColor="#72b9c9" position={[0, -2.55, 0]} />
      <OrbitControls makeDefault minDistance={5} maxDistance={15} />
    </Canvas>
  );
}

function DefectCard({ type, active, onClick, title, subtitle, color }: { type: DefectType; active: boolean; onClick: () => void; title: string; subtitle: string; color: string }) {
  return <button className={active ? 'defect-card active' : 'defect-card'} onClick={onClick}><span className="defect-symbol" style={{ color }}>{type === 'vacancy' ? '○' : type === 'substitution' ? '◉' : '∿'}</span><span><b>{title}</b><small>{subtitle}</small></span><i>{active ? 'ACTIVE' : 'SELECT'}</i></button>;
}

type MeasureInfo = {
  distanceScene: number;
  latticeSteps: number;
  angstrom: number;
};

function measureBetween(a: AtomPoint, pa: THREE.Vector3, b: AtomPoint, pb: THREE.Vector3): MeasureInfo {
  const distanceScene = pa.distanceTo(pb);
  const latticeSteps = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  return { distanceScene, latticeSteps, angstrom: latticeSteps * LATTICE_A };
}

export default function App() {
  const [cells, setCells] = useState(4);
  const [defect, setDefect] = useState<DefectType>('vacancy');
  const [showBonds, setShowBonds] = useState(true);
  const [planeOpacity, setPlaneOpacity] = useState(.08);
  const [notice, setNotice] = useState('');
  const [selected, dispatch] = useReducer(selectionReducer, []);

  // 当前场景的唯一数据源：原子、世界坐标、化学键全部由此派生
  const atoms = useMemo(() => buildAtoms(cells, defect), [cells, defect]);
  const positions = useMemo(() => {
    const map = new Map<string, THREE.Vector3>();
    atoms.forEach(atom => map.set(atom.key, atomPosition(atom, cells)));
    return map;
  }, [atoms, cells]);
  const atomByKey = useMemo(() => new Map(atoms.map(atom => [atom.key, atom])), [atoms]);
  const bonds = useMemo(() => buildBonds(atoms, positions), [atoms, positions]);

  // 模型或晶胞改变后，清理已不存在的失效选择（空位/位错删点、晶胞收缩都会使旧 key 失效）
  useEffect(() => {
    dispatch({ type: 'retain', valid: new Set(atoms.map(atom => atom.key)) });
  }, [atoms]);

  // Esc 重置测量选择（不影响任何缺陷参数）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') dispatch({ type: 'reset' }); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 测量结果始终直接取自当前场景坐标
  const selectedAtoms = selected.map(key => ({ atom: atomByKey.get(key)!, point: positions.get(key)! })).filter(item => Boolean(item.atom));
  const firstDistance = selectedAtoms.length >= 2 ? measureBetween(selectedAtoms[0].atom, selectedAtoms[0].point, selectedAtoms[1].atom, selectedAtoms[1].point) : null;
  const secondDistance = selectedAtoms.length === 3 ? measureBetween(selectedAtoms[1].atom, selectedAtoms[1].point, selectedAtoms[2].atom, selectedAtoms[2].point) : null;
  const angleDeg = selectedAtoms.length === 3
    ? (() => {
      const v1 = selectedAtoms[0].point.clone().sub(selectedAtoms[1].point).normalize();
      const v2 = selectedAtoms[2].point.clone().sub(selectedAtoms[1].point).normalize();
      return (Math.acos(Math.min(1, Math.max(-1, v1.dot(v2)))) * 180) / Math.PI;
    })()
    : null;

  const phaseHint = ['点击原子拾取第 1 点（顶点在第 2 点）', '再拾取 1 点测量两点距离', '再拾取 1 点测量三点夹角', '已得夹角；拾取新原子开始新一轮'][selectedAtoms.length];
  const metrics = useMemo(() => ({ atoms: defect === 'vacancy' ? cells ** 3 - 1 : cells ** 3, neighbors: defect === 'dislocation' ? '5 / 6' : defect === 'vacancy' ? '5 / 6' : '6 / 6', strain: defect === 'dislocation' ? '8.4%' : defect === 'substitution' ? '3.1%' : '1.7%' }), [cells, defect]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><div className="brand-icon">◈</div><div><span className="eyebrow">MATERIALS SCIENCE / LATTICE LAB</span><h1>Crystal Defect Lab <span>·</span> 晶格缺陷分析</h1></div></div>
        <div className="header-meta"><span className="sample">SAMPLE / FCC-AL-04</span><button onClick={() => setNotice('结构快照已准备，可接入数据导出')}>导出快照 ↗</button></div>
      </header>
      <main className="layout">
        <section className="model-card">
          <div className="model-head">
            <div><span className="eyebrow">UNIT CELL EXPLORER</span><h2>面心立方晶格 · 缺陷结构可视化</h2></div>
            <div className="head-stats"><span><b>{cells}³</b> 晶胞</span><span><b>{metrics.atoms}</b> 原子</span></div>
          </div>
          <div className="canvas-wrap">
            <DefectScene
              atoms={atoms} positions={positions} bonds={bonds}
              defect={defect} showBonds={showBonds} planeOpacity={planeOpacity}
              selectedKeys={selected}
              onPick={key => dispatch({ type: 'pick', key })}
              onCancelLast={() => dispatch({ type: 'cancelLast' })}
            />
            <div className="model-legend"><span><i className="dot host" />基体原子</span><span><i className="dot sub" />缺陷原子</span><span><i className="dot line" />滑移/缺陷线</span></div>
            <div className="model-hint">拖拽旋转 · 滚轮缩放 · 点击原子拾取测量</div>
          </div>
        </section>
        <aside className="sidebar">
          <section className="panel summary"><span className="eyebrow">STRUCTURE SUMMARY</span><h3>晶格参数</h3><div className="summary-grid"><div><span>晶格类型</span><b>FCC</b></div><div><span>晶格常数</span><b>4.05 Å</b></div><div><span>理论密度</span><b>2.70 g/cm³</b></div><div><span>当前温度</span><b>298 K</b></div></div></section>
          <section className="panel">
            <div className="panel-title"><div><span className="eyebrow">DEFECT LIBRARY</span><h3>缺陷类型</h3></div><span className="count">3 MODELS</span></div>
            <div className="defect-list">
              <DefectCard type="vacancy" active={defect === 'vacancy'} onClick={() => setDefect('vacancy')} title="空位缺陷" subtitle="原子位置缺失" color={colors.vacancy} />
              <DefectCard type="substitution" active={defect === 'substitution'} onClick={() => setDefect('substitution')} title="替位缺陷" subtitle="异质原子替换" color={colors.substitution} />
              <DefectCard type="dislocation" active={defect === 'dislocation'} onClick={() => setDefect('dislocation')} title="刃型位错" subtitle="局部滑移面错位" color="#ef8d86" />
            </div>
          </section>
          <section className="panel controls">
            <div className="panel-title"><div><span className="eyebrow">ANALYSIS CONTROLS</span><h3>分析参数</h3></div></div>
            <label>晶胞数量 <output>{cells} × {cells} × {cells}</output><input type="range" min="3" max="5" value={cells} onChange={event => setCells(Number(event.target.value))} /></label>
            <label>晶面透明度 <output>{Math.round(planeOpacity * 100)}%</output><input type="range" min="0" max=".3" step=".01" value={planeOpacity} onChange={event => setPlaneOpacity(Number(event.target.value))} /></label>
            <button className={showBonds ? 'toggle active' : 'toggle'} onClick={() => setShowBonds(value => !value)}><span className="toggle-dot" />显示最近邻连接</button>
          </section>
          <section className="panel measure-panel">
            <div className="panel-title"><div><span className="eyebrow">GEOMETRY MEASURE</span><h3>几何复核 · 距离 / 夹角</h3></div><span className="count">{selectedAtoms.length} / 3</span></div>
            <p className="measure-state">{phaseHint}</p>
            <div className="pick-list">
              {[0, 1, 2].map(index => {
                const item = selectedAtoms[index];
                return (
                  <div className={item ? 'pick-point' : 'pick-point empty'} key={index}>
                    <span className="pick-index" style={item ? { background: PICK_COLORS[index], borderColor: PICK_COLORS[index] } : undefined}>P{index + 1}</span>
                    {item ? (
                      <span className="pick-coords">
                        <b>晶格 ({item.atom.x}, {item.atom.y}, {item.atom.z})</b>
                        <small>x {item.point.x.toFixed(3)} · y {item.point.y.toFixed(3)} · z {item.point.z.toFixed(3)}</small>
                      </span>
                    ) : <span className="pick-coords"><small>未选择</small></span>}
                  </div>
                );
              })}
            </div>
            <div className="measure-results">
              <div className={firstDistance ? 'measure-row' : 'measure-row dim'}>
                <span><i style={{ background: PICK_COLORS[0] }} />P1 – P2 距离</span>
                <b>{firstDistance ? `${firstDistance.angstrom.toFixed(2)} Å` : '—'}</b>
                {firstDistance && <small>{firstDistance.distanceScene.toFixed(3)} 场景单位 · {firstDistance.latticeSteps.toFixed(2)} 倍晶格常数</small>}
              </div>
              <div className={secondDistance ? 'measure-row' : 'measure-row dim'}>
                <span><i style={{ background: PICK_COLORS[2] }} />P2 – P3 距离</span>
                <b>{secondDistance ? `${secondDistance.angstrom.toFixed(2)} Å` : '—'}</b>
                {secondDistance && <small>{secondDistance.distanceScene.toFixed(3)} 场景单位 · {secondDistance.latticeSteps.toFixed(2)} 倍晶格常数</small>}
              </div>
              <div className={angleDeg !== null ? 'measure-row' : 'measure-row dim'}>
                <span><i style={{ background: PICK_COLORS[1] }} />∠ P1–P2–P3</span>
                <b>{angleDeg !== null ? `${angleDeg.toFixed(2)}°` : '—'}</b>
                {angleDeg !== null && <small>顶点为 P2，取自当前场景坐标</small>}
              </div>
            </div>
            <div className="measure-actions">
              <button className="measure-reset" onClick={() => dispatch({ type: 'reset' })} disabled={selected.length === 0}>重置选择</button>
              <button className="measure-undo" onClick={() => dispatch({ type: 'cancelLast' })} disabled={selected.length === 0}>取消末点</button>
            </div>
            <p className="measure-tip">点击已选原子取消该点 · 点击空白取消末点 · Esc 重置；切换模型或晶胞会自动清除失效点。</p>
          </section>
          <section className="panel metrics-panel">
            <span className="eyebrow">DEFECT METRICS</span><h3>结构指标</h3>
            <div className="metric-row"><div><span>原子数</span><b>{metrics.atoms}</b></div><div><span>平均配位</span><b>{metrics.neighbors}</b></div><div><span>局部应变</span><b>{metrics.strain}</b></div></div>
            <p>指标为演示计算结果，后续可接入真实晶体结构文件与模拟数据。</p>
          </section>
          {notice && <div className="toast" onClick={() => setNotice('')}>{notice}<span>×</span></div>}
        </aside>
      </main>
    </div>
  );
}
