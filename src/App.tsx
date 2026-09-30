import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Grid, Line, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

type DefectType = 'vacancy' | 'substitution' | 'dislocation';
type AtomPoint = {
  key: string;
  x: number;
  y: number;
  z: number;
  defect?: 'vacancy' | 'substitution' | 'normal';
};

type SelectionAction =
  | { type: 'pick'; key: string | null }
  | { type: 'reset' };

const colors = {
  host: '#64c9e1',
  substitution: '#efb863',
  vacancy: '#ef7e83',
  bond: '#4b8190',
  measure: '#ffd166',
  angle: '#7cf29e',
};
const LATTICE_SCALE = 1.25;
const DRAG_THRESHOLD_PX = 6;

const AtomPickerContext = createContext<{
  register: (key: string, mesh: THREE.Mesh | null) => void;
} | null>(null);

function atomToVector(atom: Pick<AtomPoint, 'x' | 'y' | 'z'>, cells: number) {
  const offset = (cells - 1) / 2;
  return new THREE.Vector3(
    (atom.x - offset) * LATTICE_SCALE,
    (atom.y - offset) * LATTICE_SCALE,
    (atom.z - offset) * LATTICE_SCALE,
  );
}

function buildAtoms(cells: number, defect: DefectType): AtomPoint[] {
  const atoms: AtomPoint[] = [];
  for (let x = 0; x < cells; x += 1) {
    for (let y = 0; y < cells; y += 1) {
      for (let z = 0; z < cells; z += 1) {
        const key = `${x}-${y}-${z}`;
        if (defect === 'vacancy' && x === 1 && y === 1 && z === 1) continue;
        if (defect === 'substitution' && x === 1 && y === 1 && z === 1) {
          atoms.push({ key, x, y, z, defect: 'substitution' });
        } else {
          atoms.push({ key, x, y, z, defect: 'normal' });
        }
      }
    }
  }
  if (defect === 'dislocation') {
    return atoms.filter(atom => !(atom.x === 2 && atom.y === 0 && atom.z === 2));
  }
  return atoms;
}

// Selection state machine:
// [] -> [P1] -> [P1,P2] (distance) -> [P1,P2,P3] (angle at P2).
// A new atom after three points starts a new measurement. Empty space, the
// selected atom, Escape, reset, or a model/cell change returns to [].
function selectionReducer(state: string[], action: SelectionAction): string[] {
  if (action.type === 'reset') return [];

  const { key } = action;
  if (key === null || state.includes(key)) return [];
  if (state.length >= 3) return [key];
  return [...state, key];
}

function PickingController({
  children,
  onPick,
}: {
  children: ReactNode;
  onPick: (key: string | null) => void;
}) {
  const { camera, gl, raycaster } = useThree();
  const meshes = useRef(new Map<string, THREE.Mesh>());
  const pointerStart = useRef<{ id: number; x: number; y: number } | null>(null);

  const register = useCallback((key: string, mesh: THREE.Mesh | null) => {
    if (mesh) meshes.current.set(key, mesh);
    else meshes.current.delete(key);
  }, []);

  useEffect(() => {
    const element = gl.domElement;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      pointerStart.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // Some embedded browsers release capture automatically; the
        // pointercancel/up boundary checks still handle these events.
      }
    };

    const clearPointer = (event: PointerEvent) => {
      if (pointerStart.current?.id === event.pointerId) pointerStart.current = null;
    };

    const handlePointerUp = (event: PointerEvent) => {
      const start = pointerStart.current;
      pointerStart.current = null;
      if (!start || start.id !== event.pointerId || event.button !== 0) return;

      const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (moved > DRAG_THRESHOLD_PX) return;

      const rect = element.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        return;
      }

      // One scene-level raycast over the registered atom meshes. Individual
      // per-atom onClick handlers are intentionally not used.
      const pointer = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(Array.from(meshes.current.values()), false);
      const key = hits[0]?.object.userData.key;
      onPick(typeof key === 'string' ? key : null);
    };

    element.addEventListener('pointerdown', handlePointerDown, true);
    element.addEventListener('pointerup', handlePointerUp, true);
    element.addEventListener('pointercancel', clearPointer, true);

    return () => {
      element.removeEventListener('pointerdown', handlePointerDown, true);
      element.removeEventListener('pointerup', handlePointerUp, true);
      element.removeEventListener('pointercancel', clearPointer, true);
    };
  }, [camera, gl, onPick, raycaster]);

  const api = useMemo(() => ({ register }), [register]);

  return <AtomPickerContext.Provider value={api}>{children}</AtomPickerContext.Provider>;
}

function AtomMesh({
  atom,
  position,
  selected,
}: {
  atom: AtomPoint;
  position: THREE.Vector3;
  selected: boolean;
}) {
  const picker = useContext(AtomPickerContext);
  if (!picker) throw new Error('AtomMesh must be rendered inside PickingController');

  const isSubstitution = atom.defect === 'substitution';
  const radius = isSubstitution ? 0.3 : 0.2;
  const registerMesh = useCallback(
    (mesh: THREE.Mesh | null) => picker.register(atom.key, mesh),
    [atom.key, picker],
  );

  return (
    <>
      <mesh
        ref={registerMesh}
        position={position}
        castShadow
        userData={{ key: atom.key }}
      >
        <sphereGeometry args={[radius, 18, 12]} />
        <meshStandardMaterial
          color={isSubstitution ? colors.substitution : colors.host}
          emissive={selected ? colors.measure : isSubstitution ? colors.substitution : '#000000'}
          emissiveIntensity={selected ? 0.9 : isSubstitution ? 0.35 : 0}
        />
      </mesh>
      {selected && (
        <mesh position={position} scale={radius + 0.16}>
          <sphereGeometry args={[1, 16, 10]} />
          <meshBasicMaterial color={colors.measure} wireframe transparent opacity={0.9} />
        </mesh>
      )}
    </>
  );
}

function MeasurementOverlay({ positions }: { positions: THREE.Vector3[] }) {
  const arcPoints = useMemo(() => {
    if (positions.length < 3) return [];

    const first = positions[0].clone().sub(positions[1]);
    const second = positions[2].clone().sub(positions[1]);
    const firstLength = first.length();
    const secondLength = second.length();
    if (firstLength === 0 || secondLength === 0) return [];

    const from = first.normalize();
    const to = second.normalize();
    const angle = from.angleTo(to);
    const axis = new THREE.Vector3().crossVectors(from, to);
    if (axis.lengthSq() < 1e-10) return [];

    const radius = Math.min(0.68, firstLength * 0.38, secondLength * 0.38);
    const quaternion = new THREE.Quaternion().setFromAxisAngle(axis.normalize(), angle);
    const points: THREE.Vector3[] = [];
    for (let index = 0; index <= 32; index += 1) {
      const step = new THREE.Quaternion().slerp(quaternion, index / 32);
      points.push(
        positions[1].clone().add(from.clone().applyQuaternion(step).multiplyScalar(radius)),
      );
    }
    return points;
  }, [positions]);

  if (positions.length < 2) return null;

  return (
    <group>
      {positions.length === 2 ? (
        <Line points={positions} color={colors.measure} lineWidth={2.5} />
      ) : (
        <>
          <Line points={[positions[0], positions[1]]} color={colors.measure} lineWidth={2.5} />
          <Line points={[positions[1], positions[2]]} color={colors.measure} lineWidth={2.5} />
          {arcPoints.length > 1 && (
            <Line points={arcPoints} color={colors.angle} lineWidth={2.2} />
          )}
        </>
      )}
    </group>
  );
}

function DefectScene({
  cells,
  defect,
  showBonds,
  planeOpacity,
  atoms,
  atomVectors,
  selectedKeys,
  onPick,
}: {
  cells: number;
  defect: DefectType;
  showBonds: boolean;
  planeOpacity: number;
  atoms: AtomPoint[];
  atomVectors: Map<string, THREE.Vector3>;
  selectedKeys: string[];
  onPick: (key: string | null) => void;
}) {
  const bonds = useMemo(() => {
    const list: [THREE.Vector3, THREE.Vector3][] = [];
    atoms.forEach(atom => {
      const origin = atomVectors.get(atom.key);
      if (!origin) return;
      [
        atomVectors.get(`${atom.x + 1}-${atom.y}-${atom.z}`),
        atomVectors.get(`${atom.x}-${atom.y}-${atom.z + 1}`),
      ].forEach(neighbor => {
        if (neighbor) list.push([origin, neighbor]);
      });
    });
    return list;
  }, [atoms, atomVectors]);

  const selectedPositions = selectedKeys
    .map(key => atomVectors.get(key))
    .filter((position): position is THREE.Vector3 => Boolean(position));
  const selectedKeySet = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const vacancyPosition = atomToVector({ x: 1, y: 1, z: 1 }, cells);

  return (
    <Canvas shadows camera={{ position: [8, 6, 8], fov: 38 }}>
      <color attach="background" args={['#09151d']} />
      <ambientLight intensity={1.25} />
      <directionalLight position={[5, 8, 5]} intensity={2.3} castShadow />
      <pointLight position={[-4, 2, 3]} color="#5fd4ee" intensity={12} distance={12} />
      <PickingController onPick={onPick}>
        <group rotation={[0.15, -0.35, 0]}>
          {showBonds &&
            bonds.map((bond, index) => (
              <Line
                key={index}
                points={bond}
                color={colors.bond}
                lineWidth={1.2}
                transparent
                opacity={0.65}
              />
            ))}
          {atoms.map(atom => {
            const position = atomVectors.get(atom.key);
            if (!position) return null;
            return (
              <AtomMesh
                key={atom.key}
                atom={atom}
                position={position}
                selected={selectedKeySet.has(atom.key)}
              />
            );
          })}
          <MeasurementOverlay positions={selectedPositions} />
          {defect === 'vacancy' && (
            <mesh position={vacancyPosition}>
              <sphereGeometry args={[0.35, 16, 12]} />
              <meshBasicMaterial color={colors.vacancy} transparent opacity={0.26} wireframe />
            </mesh>
          )}
          {defect === 'dislocation' && (
            <Line
              points={[
                new THREE.Vector3(-1.9, -1.9, 0),
                new THREE.Vector3(-0.65, -1.9, 0),
                new THREE.Vector3(-0.65, -0.65, 0),
                new THREE.Vector3(0.65, -0.65, 0),
                new THREE.Vector3(0.65, 0.65, 0),
                new THREE.Vector3(1.9, 0.65, 0),
              ]}
              color="#f08d87"
              lineWidth={4}
            />
          )}
        </group>
      </PickingController>
      <mesh rotation={[0, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[5.6, 5.6]} />
        <meshBasicMaterial color="#69cde2" transparent opacity={planeOpacity} side={THREE.DoubleSide} />
      </mesh>
      <Grid
        args={[8, 8]}
        cellSize={1.25}
        sectionSize={2.5}
        cellColor="#326778"
        sectionColor="#72b9c9"
        position={[0, -2.55, 0]}
      />
      <OrbitControls makeDefault minDistance={5} maxDistance={15} />
    </Canvas>
  );
}

function DefectCard({
  type,
  active,
  onClick,
  title,
  subtitle,
  color,
}: {
  type: DefectType;
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  color: string;
}) {
  return (
    <button className={active ? 'defect-card active' : 'defect-card'} onClick={onClick}>
      <span className="defect-symbol" style={{ color }}>
        {type === 'vacancy' ? '○' : type === 'substitution' ? '◉' : '∿'}
      </span>
      <span>
        <b>{title}</b>
        <small>{subtitle}</small>
      </span>
      <i>{active ? 'ACTIVE' : 'SELECT'}</i>
    </button>
  );
}

function formatNumber(value: number) {
  const normalized = Math.round(value * 100) / 100;
  return Object.is(normalized, -0) ? '0.00' : normalized.toFixed(2);
}

export default function App() {
  const [cells, setCells] = useState(4);
  const [defect, setDefect] = useState<DefectType>('vacancy');
  const [showBonds, setShowBonds] = useState(true);
  const [planeOpacity, setPlaneOpacity] = useState(0.08);
  const [notice, setNotice] = useState('');
  const [selectedKeys, dispatchSelection] = useReducer(selectionReducer, []);

  const atoms = useMemo(() => buildAtoms(cells, defect), [cells, defect]);
  const atomByKey = useMemo(() => new Map(atoms.map(atom => [atom.key, atom])), [atoms]);
  const atomVectors = useMemo(
    () => new Map(atoms.map(atom => [atom.key, atomToVector(atom, cells)])),
    [atoms, cells],
  );

  // A changed lattice or defect model is a new scene. Clear the measurement
  // state so no old overlay can be interpreted as current geometry.
  useLayoutEffect(() => {
    dispatchSelection({ type: 'reset' });
  }, [cells, defect]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dispatchSelection({ type: 'reset' });
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handlePick = useCallback((key: string | null) => {
    dispatchSelection({ type: 'pick', key });
  }, []);

  const selectedAtoms = selectedKeys
    .map(key => atomByKey.get(key))
    .filter((atom): atom is AtomPoint => Boolean(atom));
  const selectedPositions = selectedKeys
    .map(key => atomVectors.get(key))
    .filter((position): position is THREE.Vector3 => Boolean(position));

  const measurements = useMemo(() => {
    const values: { label: string; value: string }[] = [];
    if (selectedPositions.length < 2) return values;

    const distance12 = selectedPositions[0].distanceTo(selectedPositions[1]);
    values.push({ label: 'P1 → P2 距离', value: `${formatNumber(distance12)} 场景单位` });

    if (selectedPositions.length === 3) {
      const distance23 = selectedPositions[1].distanceTo(selectedPositions[2]);
      const first = selectedPositions[0].clone().sub(selectedPositions[1]);
      const second = selectedPositions[2].clone().sub(selectedPositions[1]);
      const angle = (first.angleTo(second) * 180) / Math.PI;
      values.push({ label: 'P2 → P3 距离', value: `${formatNumber(distance23)} 场景单位` });
      values.unshift({ label: '∠P1-P2-P3（顶点 P2）', value: `${formatNumber(angle)}°` });
    }
    return values;
  }, [selectedPositions]);

  const phase =
    selectedAtoms.length === 0
      ? 'empty'
      : selectedAtoms.length === 1
        ? 'origin'
        : selectedAtoms.length === 2
          ? 'distance'
          : 'angle';
  const phaseText = {
    empty: '拾取第 1 个原子',
    origin: '拾取第 2 个原子以测量距离',
    distance: '拾取第 3 个原子以测量夹角',
    angle: '测量完成；点击新原子开始下一次复核',
  }[phase];

  const metrics = useMemo(
    () => ({
      atoms: defect === 'vacancy' ? cells ** 3 - 1 : cells ** 3,
      neighbors:
        defect === 'dislocation' || defect === 'vacancy'
          ? '5 / 6'
          : '6 / 6',
      strain:
        defect === 'dislocation' ? '8.4%' : defect === 'substitution' ? '3.1%' : '1.7%',
    }),
    [cells, defect],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">◈</div>
          <div>
            <span className="eyebrow">MATERIALS SCIENCE / LATTICE LAB</span>
            <h1>
              Crystal Defect Lab <span>·</span> 晶格缺陷分析
            </h1>
          </div>
        </div>
        <div className="header-meta">
          <span className="sample">SAMPLE / FCC-AL-04</span>
          <button onClick={() => setNotice('结构快照已准备，可接入数据导出')}>导出快照 ↗</button>
        </div>
      </header>

      <main className="layout">
        <section className="model-card">
          <div className="model-head">
            <div>
              <span className="eyebrow">UNIT CELL EXPLORER</span>
              <h2>面心立方晶格 · 缺陷结构可视化</h2>
            </div>
            <div className="head-stats">
              <span>
                <b>{cells}³</b> 晶胞
              </span>
              <span>
                <b>{metrics.atoms}</b> 原子
              </span>
            </div>
          </div>

          <div className="canvas-wrap">
            <DefectScene
              cells={cells}
              defect={defect}
              showBonds={showBonds}
              planeOpacity={planeOpacity}
              atoms={atoms}
              atomVectors={atomVectors}
              selectedKeys={selectedKeys}
              onPick={handlePick}
            />

            <div className="measurement-panel">
              <div className="measurement-head">
                <div>
                  <span className="eyebrow">GEOMETRY MEASURE</span>
                  <b>几何关系复核</b>
                </div>
                <button
                  className="reset-measure"
                  disabled={selectedKeys.length === 0}
                  onClick={() => dispatchSelection({ type: 'reset' })}
                >
                  重置
                </button>
              </div>

              <div className={`selection-state state-${phase}`}>
                <i />
                {phaseText}
              </div>

              <div className="selected-atoms">
                {selectedAtoms.length === 0 ? (
                  <p>尚未选择原子</p>
                ) : (
                  selectedAtoms.map((atom, index) => {
                    const position = selectedPositions[index];
                    return (
                      <div className="selected-atom" key={atom.key}>
                        <b>P{index + 1}</b>
                        <span>
                          晶格 ({atom.x}, {atom.y}, {atom.z})
                          {position && (
                            <small>
                              场景 ({formatNumber(position.x)}, {formatNumber(position.y)},{' '}
                              {formatNumber(position.z)})
                            </small>
                          )}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>

              {measurements.length > 0 && (
                <div className="measurement-readouts">
                  {measurements.map(item => (
                    <div key={item.label}>
                      <span>{item.label}</span>
                      <b>{item.value}</b>
                    </div>
                  ))}
                </div>
              )}

              <p className="measurement-help">
                统一射线拾取：点击原子选择，点击空白或已选原子取消；拖拽旋转不会误选，Esc 重置。
              </p>
            </div>

            <div className="model-legend">
              <span>
                <i className="dot host" />
                基体原子
              </span>
              <span>
                <i className="dot sub" />
                缺陷原子
              </span>
              <span>
                <i className="dot line" />
                滑移/缺陷线
              </span>
            </div>
            <div className="model-hint">拖拽旋转 · 滚轮缩放 · 点击原子测量 · 三维晶面已叠加</div>
          </div>
        </section>

        <aside className="sidebar">
          <section className="panel summary">
            <span className="eyebrow">STRUCTURE SUMMARY</span>
            <h3>晶格参数</h3>
            <div className="summary-grid">
              <div>
                <span>晶格类型</span>
                <b>FCC</b>
              </div>
              <div>
                <span>晶格常数</span>
                <b>4.05 Å</b>
              </div>
              <div>
                <span>理论密度</span>
                <b>2.70 g/cm³</b>
              </div>
              <div>
                <span>当前温度</span>
                <b>298 K</b>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">
              <div>
                <span className="eyebrow">DEFECT LIBRARY</span>
                <h3>缺陷类型</h3>
              </div>
              <span className="count">3 MODELS</span>
            </div>
            <div className="defect-list">
              <DefectCard
                type="vacancy"
                active={defect === 'vacancy'}
                onClick={() => setDefect('vacancy')}
                title="空位缺陷"
                subtitle="原子位置缺失"
                color={colors.vacancy}
              />
              <DefectCard
                type="substitution"
                active={defect === 'substitution'}
                onClick={() => setDefect('substitution')}
                title="替位缺陷"
                subtitle="异质原子替换"
                color={colors.substitution}
              />
              <DefectCard
                type="dislocation"
                active={defect === 'dislocation'}
                onClick={() => setDefect('dislocation')}
                title="刃型位错"
                subtitle="局部滑移面错位"
                color="#ef8d86"
              />
            </div>
          </section>

          <section className="panel controls">
            <div className="panel-title">
              <div>
                <span className="eyebrow">ANALYSIS CONTROLS</span>
                <h3>分析参数</h3>
              </div>
            </div>
            <label>
              晶胞数量 <output>{cells} × {cells} × {cells}</output>
              <input
                type="range"
                min="3"
                max="5"
                value={cells}
                onChange={event => setCells(Number(event.target.value))}
              />
            </label>
            <label>
              晶面透明度 <output>{Math.round(planeOpacity * 100)}%</output>
              <input
                type="range"
                min="0"
                max="0.3"
                step="0.01"
                value={planeOpacity}
                onChange={event => setPlaneOpacity(Number(event.target.value))}
              />
            </label>
            <button
              className={showBonds ? 'toggle active' : 'toggle'}
              onClick={() => setShowBonds(value => !value)}
            >
              <span className="toggle-dot" />
              显示最近邻连接
            </button>
          </section>

          <section className="panel metrics-panel">
            <span className="eyebrow">DEFECT METRICS</span>
            <h3>结构指标</h3>
            <div className="metric-row">
              <div>
                <span>原子数</span>
                <b>{metrics.atoms}</b>
              </div>
              <div>
                <span>平均配位</span>
                <b>{metrics.neighbors}</b>
              </div>
              <div>
                <span>局部应变</span>
                <b>{metrics.strain}</b>
              </div>
            </div>
            <p>指标为演示计算结果，后续可接入真实晶体结构文件与模拟数据。</p>
          </section>

          {notice && (
            <div className="toast" onClick={() => setNotice('')}>
              {notice}
              <span>×</span>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
