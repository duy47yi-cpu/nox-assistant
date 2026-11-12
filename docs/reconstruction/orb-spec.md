# Nox — Orb Spec | Спецификация сферы из точек с ядром

> Опорный визуал: `02-sphere-2x.png` (проволочная сфера в референсе), `05/06-sphere-9-11s.jpg` (деформация сетки 9.0–12.9с, центр неподвижен, форма меняется).  
> Верификация: `verification-2026-11-09.md` по оригинальным MP4 `IMG_22660/39258/47650` через FFmpeg 9.0.2 (50 кадров @10fps).  
> Требование: **сфера из светящихся точек с различимым внутренним ядром**, глубина, контролируемое движение, сдержанное свечение.  
> Запрет: текстура Юпитера, кольца, хаотичные частицы, гигантские панели.  
> Классификация в этом файле: **[В]=подтверждено видео, [О]=оценено по кадрам, [П]=придумано для реализации**.

---

## 1. Концептуальное разделение

| Вариант | Геометрия | Материал | Когда использовать |
|---------|-----------|----------|-------------------|
| **A. Reference Wire** (для fidelity) | Сетка `~60×40` линий 1px, hollowing, белый пояс-пульс [В] | Линии `cyan #2E9AC1` 1px, opacity 0.9 [В] | Только для демо референса, флаг `variant='wire'` |
| **B. Nox Points (основной)** | `1200–1600` точек + ядро `180–220` точек [П] | Точки `additive bloom` + ядро `emissive volume` [П] | Продакшн Nox, `variant='nox'` по умолчанию |

Лейаут панели D не меняется — только содержимое `<canvas>`.

---

## 2. Геометрия Nox Points

### 2.1 Внешняя оболочка — Points Cloud

```
Радиус сферы R: 128px (для панели 360px, canvas 260×260) — [И] 72.7% ширины панели
Количество точек N: 1400 ±200 — [П] плотность как в 02-sphere-2x, но точками
Распределение: Fibonacci sphere (равномерно), не random
Размер точки: 1.2px–1.8px в зависимости от глубины (perspective size)
```

Формула распределения (JS):

```js
for (let i=0; i<N; i++) {
  const y = 1 - (i / (N-1)) * 2; // -1→1
  const r = Math.sqrt(1 - y*y);
  const theta = i * 2.399963; // golden angle
  const x = Math.cos(theta) * r;
  const z = Math.sin(theta) * r;
  // store (x,y,z) * R
}
```

### 2.2 Ядро — внутренняя сфера

```
Радиус ядра Rc: 0.42 × R = 54px — [О] различимо, ~40–45% внешней
Точек ядра Nc: 200, распределение — denser к центру (r ∝ cbrt(rand))
Цвет ядра: accent с теплым сдвигом — [П] #3AAAD6 → #5AD0E8 (inner glow)
Ядро не проволочное — объёмное свечение, blur 18px
```

### 2.3 Деформация (breathing + flow) — ключевое отличие от статики

Вместо случайного движения точек — **деформация вершин по нормали** (как в референсе 05/06, где сетка гнётся, центр стоит).

```
vertex' = vertex * (1 + deform * normal)
deform = sin( uv.y * 3.0 + time*0.6 ) * 0.06
        + sin( uv.x * 4.0 - time*0.4 ) * 0.04
        + waveBand * 0.10 // нижний обод 9.0–9.5с — опционально

Амплитуда: ±6% радиуса (макс 8px) — [О] в кадрах деформация ~5–10%
Частота: 0.5–0.7 Гц (период 1.5–2.0с) — [О] по 05/06: за 3.2с ~2 цикла
Easing: sine in-out, никаких spring — плавно, непрерывно
```

Нижний «волнистый обод» (яркая полоса снизу 9.0–9.5с) — отдельный шейдерный пояс:

```
belt: y < -0.55, width 0.12*R, color #E0F4FF, opacity 0.9 → 0.0 за 0.3с fade
Появляется только в idle при «глубоком вдохе» каждые 6–8с на 0.6с
```

---

## 3. Материалы и свечение

### 3.1 Точки оболочки

| Свойство | Значение | Статус |
|----------|----------|--------|
| Цвет ближней полусферы (facing camera) | `#9AD6EA`–`#C8ECF6` (светлый cyan) | [О] ярко на краю |
| Цвет дальней полусферы | `#2A5A6B`–`#1A3D4F` (тёмный, alpha 0.25) | [О] глубина |
| Размер | `1.2 + depth*0.6` px, `depth = (z/R+1)/2` | [П] |
| Opacity | `0.85 * depth + 0.15` — задние видны, но тускло | [О] |
| Bloom (glow) | outer `box-shadow 0 0 6px accent 30%`, в Canvas — `additive blending + radial gradient` | [О] сдержанно, не bloom 40px |
| Blend | `Additive` в Three.js (`THREE.AdditiveBlending`) | [П] |

### 3.2 Ядро

| Свойство | Значение | Статус |
|----------|----------|--------|
| Fill | `radial-gradient(circle, #E0F4FF 0%, #3AAAD6 45%, #1A5A7B 100%)` за точками | [П] |
| Opacity | `0.9` center → `0.0` edge (falloff `pow(1-d, 2.2)`) | [П] |
| Glow | `filter: blur(18px)` + `opacity 0.5` halo `r 78px` | [О] |
| Пульс | `scale 1.0 → 1.06` синхронно с дыханием оболочки | [П] |

### 3.3 Внешнее свечение (halo)

```
halo: r = R * 1.18, color var(--accent) 10%, blur 40px, opacity 0.14 — [О] едва заметно
Не увеличивать >18% — иначе «дешёвый neon»
```

---

## 4. Освещение (виртуальное)

Без реального света — имитация объёмом:

- **Key light** сверху-слева (−0.6, 0.8, 0.5) — ярче на 18% в этой зоне — [О] в 02-sphere-2x верх светлее
- **Rim** снизу-справа (0.5, −0.4, −0.2) — контровой тонкий край +10% brightness
- Реализовать как `brightness = 0.85 + dot(normal, key)*0.18 + dot(normal, rim)*0.10` в шейдере / per-point JS.

---

## 5. Состояния (state machine)

Все состояния — тот же canvas, меняются параметры, геометрия не заменяется.

| State | Триггер | Визуал | Параметры |
|-------|---------|--------|-----------|
| **idle** | нет ввода 1.2с, нет хода | Дыхание 1.8с, амплитуда 6%, ядро 0.9 opacity, belt каждые 7с | `speed 0.6, deform 0.06, glow 0.14` |
| **attentive** | focus в composer, непустой draft | Медленный наклон 2° к полю ввода, дыхание чуть глубже 8% | `tilt 2deg, deform 0.07` за 300ms ease-out |
| **listening** | mic active | Лёгкая рябь по экватору 1.2 Гц, ядро пульсирует в такт уровню `voice 0–1` | `ripple amp = voice*0.08, core scale = 1+voice*0.04` |
| **thinking** | Agent.run → tool loop | Ускоренное дыхание 0.9с, амплитуда 9%, свечение +40%, точки ярче | `speed 1.0, deform 0.09, brightness +0.2, halo 0.22` |
| **speaking** | TTS поток | Дыхание + боковая волна в такт `voice`, belt отключается | `wave amp = voice*0.12` |
| **waiting_approval** | `decide → approval` | Замедление 2.4с, янтарный оттенок `hue +32°`, ореол янтарь 14%, пульс стоп-кадр | `speed 0.3, hue shift 32°, halo amber` |
| **error** | tool failed | Красный оттенок `hue → #FF5C5C`, дрожь 1.5% быстро затухает 400ms | `shake 1.5% →0, progress ring red` |
| **success** | verified | Короткая вспышка + scale 1.04 на 220ms, возврат | `scale 1.04, flash 0.2s, ease-out` |

Цвета состояний берутся из токенов `--warn`, `--err`, `--ok`, не хардкод.

---

## 6. Дополнительные орбиты (кольцо шагов)

В `DESIGN.md` было кольцо шагов вокруг шара — в референсе его **нет**. Для Nox — опционально, минимально:

```
Если есть ход (runId): тонкое кольцо r = R*1.22, толщина 1px, цвет text-3 20%
Бусины: 4px dot, gap 8px, статусы — ok/warn/err/accent как в DESIGN.md
Появляются только во время thinking, исчезают за 400ms fade после завершения
```

Не делать постоянную орбиту — лишний шум.

---

## 7. Технические варианты

### Рекомендуемый: **Three.js Points + Custom Shader** [выбор для Nox]

| Критерий | Оценка |
|----------|--------|
| Глубина и 1600 точек + ядро + деформация вершин | Canvas 2D — O(N) JS каждый кадр, 1600× sin/cos = ~1.2ms/кадр, ок, но шейдер на GPU быстрее и даёт bloom |
| Свечение (additive, halo) | WebGL `AdditiveBlending` нативно, Canvas — ручной radial gradient дороже |
| Интеграция в Electron | `three@0.160` ~150kb gz, уже есть в экосистеме, `OrbitControls` не нужен |
| Производительность | 60fps на Intel iGPU при 1600 точек, <2ms/кадр, <12MB VRAM |

**Почему не CSS:** точки — не DOM, 1400 div = layout thrash.  
**Почему не чистый Canvas 2D:** возможно, но bloom и depth придётся эмулировать; Three.js даёт готовый depth + blending + DPR.

### Фолбэк: Canvas 2D (если Three нельзя)

- `OffscreenCanvas` + `ImageData`, точки — `arc( x, y, r )`, цвет через `depth`, bloom — `shadowBlur 6px` только для front точек (z>0).
- DPR aware: `canvas.width = rect.width * devicePixelRatio`.

### Что не использовать

- `WebGPU` — оверхед, не нужен.
- `Lottie / video` — не интерактивно.
- `Particle engine (tsParticles)` — хаос, неконтролируемая физика.
- Текстура Юпитера — прямо запрещено.

---

## 8. Минимальная реализация (Three.js, готово к вставке)

```tsx
// OrbNox.tsx
import * as THREE from 'three'
import { useEffect, useRef } from 'react'

export function OrbNox({ state = 'idle', voice = 0, progress = [] }) {
  const mount = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const W=260, H=260, R=128, N=1400
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(28, 1, 1, 600); camera.position.z = 340
    const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true })
    renderer.setPixelRatio(devicePixelRatio); renderer.setSize(W,H)
    mount.current!.appendChild(renderer.domElement)

    // geometry
    const geo = new THREE.BufferGeometry()
    const pos = new Float32Array(N*3), col = new Float32Array(N*3), size = new Float32Array(N)
    for(let i=0;i<N;i++){
      const y = 1 - (i/(N-1))*2
      const r = Math.sqrt(1 - y*y)
      const th = i*2.399963
      const x = Math.cos(th)*r, z = Math.sin(th)*r
      pos[i*3]=x*R; pos[i*3+1]=y*R; pos[i*3+2]=z*R
      col[i*3]=0.58; col[i*3+1]=0.84; col[i*3+2]=0.92
      size[i]=1.4
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos,3))
    geo.setAttribute('color', new THREE.BufferAttribute(col,3))
    geo.setAttribute('size', new THREE.BufferAttribute(size,1))

    const mat = new THREE.PointsMaterial({
      size: 1.6, vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    })
    const points = new THREE.Points(geo, mat); scene.add(points)

    // core glow mesh
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(R*0.42, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0x3AAAD6, transparent:true, opacity:0.18 })
    ); scene.add(core)

    let raf=0, t0=performance.now()
    const animate = () => {
      const t = (performance.now()-t0)/1000
      const speed = state==='thinking'?1.0 : state==='idle'?0.6 : 0.3
      const amp = state==='thinking'?0.09 : 0.06
      const p = geo.attributes.position as THREE.BufferAttribute
      const c = geo.attributes.color as THREE.BufferAttribute
      const s = geo.attributes.size as THREE.BufferAttribute
      for(let i=0;i<N;i++){
        const ox = pos[i*3], oy = pos[i*3+1], oz = pos[i*3+2]
        const len = Math.sqrt(ox*ox+oy*oy+oz*oz) || 1
        const nx=ox/len, ny=oy/len, nz=oz/len
        const d = Math.sin(oy*0.03 + t*speed*2.0)*amp + Math.sin(ox*0.04 - t*speed*1.2)*amp*0.6
        p.setXYZ(i, ox*(1+d*nx*0.5), oy*(1+d*ny*0.5), oz*(1+d*nz*0.5))
        // depth color
        const depth = (p.getZ(i)/R + 1)/2 // 0 back, 1 front
        c.setXYZ(i, 0.22+depth*0.36, 0.48+depth*0.30, 0.62+depth*0.22)
        s.setX(i, 1.2 + depth*0.6 + voice*0.6*(Math.sin(t*8 + i*0.01)*0.5+0.5))
      }
      p.needsUpdate=true; c.needsUpdate=true; s.needsUpdate=true
      points.rotation.y = t*0.08 // медленное вращение 0.08 rad/s ≈ 12s оборот
      core.scale.setScalar(1 + Math.sin(t*speed*1.8)*0.03 + voice*0.04)
      renderer.render(scene,camera)
      raf = requestAnimationFrame(animate)
    }
    animate()
    return () => { cancelAnimationFrame(raf); renderer.dispose(); mount.current?.removeChild(renderer.domElement) }
  }, [state, voice])

  return <div ref={mount} className="orb-nox" style={{width:260,height:260}} role="img" aria-label={`Состояние: ${state}`} />
}
```

Настройки производительности: `powerPreference: 'low-power'`, `dpr = min(devicePixelRatio, 2)`, пауза когда `document.hidden` или `prefers-reduced-motion`.

---

## 9. Accessibility и контроль движения

- `prefers-reduced-motion: reduce` → `amp=0, rotation=0`, только цветовые переходы.
- `html[data-motion="off"]` (переключатель в Настройках → Вид) → статичная сфера, `opacity` и `color` transitions остаются.
- `aria-label` на wrapper — «Шар состояния: ожидание/работа/…».
- Клавиатура не фокусит canvas (`tabindex -1`).

---

## 10. Чек-лист приёмки сферы

- [ ] 1400 точек, Fibonacci, без кластеров на полюсах
- [ ] Ядро видно внутри, не плоский круг
- [ ] Дыхание ±6%, период ~1.8с, центр неподвижен
- [ ] Ближние ярче/больше, дальние темнее — есть объём
- [ ] Bloom сдержанный, halo 14% не засвечивает панель
- [ ] States: idle→thinking ускоряется, waiting amber, error red без тряски
- [ ] 60fps на iGPU, пауза в hidden, respect reduced-motion
- [ ] Никаких колец с насечками, Юпитера, случайных частиц

