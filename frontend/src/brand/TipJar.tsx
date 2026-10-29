// Wifly tip jar: flat-premium glass jar holding the OFFICIAL $WIF token art.
// The coins are the real /brand/wif-token-256.png and /brand/wif-coin-256.png files, embedded unchanged (never redrawn).
// wif-coin-256.png is wif-token-flat.png cropped to its coin circle (140KB instead of 788KB), placed on the same circle.
// animate: a coin drops into the slot, the jar wobbles, and the counter ticks +1 on each drop. Loops every 2.8s.
// Honours prefers-reduced-motion (shows the still with the coin mid-drop).
// Geometry and timing are generated from brand/final/_src/tipjar*.py; the preview GIF uses the same numbers.
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';

const BODY_STATIC = "<path d=\"M128 104 L272 104 L272 120 C272 138 330 142 330 196 L330 400 C330 436 306 456 270 456 L130 456 C94 456 70 436 70 400 L70 196 C70 142 128 138 128 120 Z\" fill=\"#EAF1EE\" fill-opacity=\"0.55\"/><clipPath id=\"__ID__-in\"><path d=\"M136 112 L264 112 L264 122 C264 146 320 150 320 198 L320 398 C320 428 300 446 268 446 L132 446 C100 446 80 428 80 398 L80 198 C80 150 136 146 136 122 Z\"/></clipPath><g clip-path=\"url(#__ID__-in)\"><image href=\"/brand/wif-token-256.png\" x=\"70\" y=\"350\" width=\"120\" height=\"121.9\" transform=\"rotate(-14 130.0 410.0)\"/><image href=\"/brand/wif-token-256.png\" x=\"178\" y=\"362\" width=\"118\" height=\"119.8\" transform=\"rotate(8 237.0 421.0)\"/><image href=\"/brand/wif-token-256.png\" x=\"250\" y=\"346\" width=\"116\" height=\"117.8\" transform=\"rotate(22 308.0 404.0)\"/><image href=\"/brand/wif-token-256.png\" x=\"118\" y=\"312\" width=\"112\" height=\"113.8\" transform=\"rotate(-30 174.0 368.0)\"/><image href=\"/brand/wif-token-256.png\" x=\"206\" y=\"300\" width=\"114\" height=\"115.8\" transform=\"rotate(12 263.0 357.0)\"/><image href=\"/brand/wif-token-256.png\" x=\"150\" y=\"262\" width=\"108\" height=\"109.7\" transform=\"rotate(-6 204.0 316.0)\"/></g><g clip-path=\"url(#__ID__-in)\" fill=\"#FFFFFF\"><rect x=\"96\" y=\"200\" width=\"16\" height=\"196\" rx=\"8\" fill-opacity=\"0.78\"/><rect x=\"120\" y=\"210\" width=\"6\" height=\"120\" rx=\"3\" fill-opacity=\"0.6\"/><path d=\"M150 150 C168 140 188 138 204 138\" stroke=\"#FFFFFF\" stroke-opacity=\"0.85\" stroke-width=\"7\" stroke-linecap=\"round\" fill=\"none\"/><rect x=\"300\" y=\"230\" width=\"8\" height=\"130\" rx=\"4\" fill-opacity=\"0.45\"/></g><path d=\"M136 112 L264 112 L264 122 C264 146 320 150 320 198 L320 398 C320 428 300 446 268 446 L132 446 C100 446 80 428 80 398 L80 198 C80 150 136 146 136 122 Z\" fill=\"none\" stroke=\"#110E08\" stroke-opacity=\"0.14\" stroke-width=\"2\"/><path d=\"M96 436 C140 446 260 446 304 436\" fill=\"none\" stroke=\"#110E08\" stroke-opacity=\"0.18\" stroke-width=\"2.5\" stroke-linecap=\"round\"/><path d=\"M128 104 L272 104 L272 120 C272 138 330 142 330 196 L330 400 C330 436 306 456 270 456 L130 456 C94 456 70 436 70 400 L70 196 C70 142 128 138 128 120 Z\" fill=\"none\" stroke=\"#110E08\" stroke-width=\"5\" stroke-linejoin=\"round\"/><rect x=\"112\" y=\"80\" width=\"176\" height=\"30\" rx=\"12\" fill=\"#EAF1EE\" fill-opacity=\"0.8\" stroke=\"#110E08\" stroke-width=\"5\"/><rect x=\"126\" y=\"88\" width=\"26\" height=\"6\" rx=\"3\" fill=\"#FFFFFF\"/><rect x=\"164\" y=\"90\" width=\"72\" height=\"10\" rx=\"5\" fill=\"#110E08\"/><rect x=\"150\" y=\"196\" width=\"100\" height=\"40\" rx=\"12\" fill=\"#CCFF00\" stroke=\"#110E08\" stroke-width=\"4\"/><g transform=\"translate(162.5 226)\"><g transform=\"translate(0.00 0) scale(0.028)\"><path d=\"M270 0V-600H90V-700H550V-600H370V0Z\" fill=\"#110E08\"/></g><g transform=\"translate(18.76 0) scale(0.028)\"><path d=\"M90 0V-100H270V-600H90V-700H550V-600H370V-100H550V0Z\" fill=\"#110E08\"/></g><g transform=\"translate(37.52 0) scale(0.028)\"><path d=\"M70 0V-700H530V-400H170V0ZM170 -500H430V-600H170Z\" fill=\"#110E08\"/></g><g transform=\"translate(55.16 0) scale(0.028)\"><path d=\"M60 -200H160Q160 -173 184.5 -150.0Q209 -127 250.0 -113.5Q291 -100 340 -100Q390 -100 430.5 -113.5Q471 -127 495.5 -150.0Q520 -173 520 -200V-300Q520 -328 495.5 -350.5Q471 -373 430.5 -386.5Q390 -400 340 -400H60V-500Q60 -555 97.5 -600.5Q135 -646 199.0 -673.0Q263 -700 340 -700Q418 -700 481.5 -673.0Q545 -646 582.5 -600.5Q620 -555 620 -500H520Q520 -528 495.5 -550.5Q471 -573 430.5 -586.5Q390 -600 340 -600Q291 -600 250.0 -586.5Q209 -573 184.5 -550.5Q160 -528 160 -500H340Q418 -500 481.5 -473.0Q545 -446 582.5 -400.5Q620 -355 620 -300V-200Q620 -145 582.5 -99.5Q545 -54 481.5 -27.0Q418 0 340 0Q263 0 199.0 -27.0Q135 -54 97.5 -99.5Q60 -145 60 -200Z\" fill=\"#110E08\"/></g></g><image href=\"/brand/wif-coin-256.png\" x=\"166.00\" y=\"-12.00\" width=\"68.00\" height=\"68.00\"/><g stroke=\"#110E08\" stroke-width=\"4\" stroke-linecap=\"round\" opacity=\"0.5\"><path d=\"M178 -20 v-10\"/><path d=\"M200 -22 v-14\"/><path d=\"M222 -20 v-10\"/></g>";
const BODY_ANIM = "<path d=\"M128 104 L272 104 L272 120 C272 138 330 142 330 196 L330 400 C330 436 306 456 270 456 L130 456 C94 456 70 436 70 400 L70 196 C70 142 128 138 128 120 Z\" fill=\"#EAF1EE\" fill-opacity=\"0.55\"/><clipPath id=\"__ID__-in\"><path d=\"M136 112 L264 112 L264 122 C264 146 320 150 320 198 L320 398 C320 428 300 446 268 446 L132 446 C100 446 80 428 80 398 L80 198 C80 150 136 146 136 122 Z\"/></clipPath><g clip-path=\"url(#__ID__-in)\"><image href=\"/brand/wif-token-256.png\" x=\"70\" y=\"350\" width=\"120\" height=\"121.9\" transform=\"rotate(-14 130.0 410.0)\"/><image href=\"/brand/wif-token-256.png\" x=\"178\" y=\"362\" width=\"118\" height=\"119.8\" transform=\"rotate(8 237.0 421.0)\"/><image href=\"/brand/wif-token-256.png\" x=\"250\" y=\"346\" width=\"116\" height=\"117.8\" transform=\"rotate(22 308.0 404.0)\"/><image href=\"/brand/wif-token-256.png\" x=\"118\" y=\"312\" width=\"112\" height=\"113.8\" transform=\"rotate(-30 174.0 368.0)\"/><image href=\"/brand/wif-token-256.png\" x=\"206\" y=\"300\" width=\"114\" height=\"115.8\" transform=\"rotate(12 263.0 357.0)\"/><image href=\"/brand/wif-token-256.png\" x=\"150\" y=\"262\" width=\"108\" height=\"109.7\" transform=\"rotate(-6 204.0 316.0)\"/></g><g clip-path=\"url(#__ID__-in)\" fill=\"#FFFFFF\"><rect x=\"96\" y=\"200\" width=\"16\" height=\"196\" rx=\"8\" fill-opacity=\"0.78\"/><rect x=\"120\" y=\"210\" width=\"6\" height=\"120\" rx=\"3\" fill-opacity=\"0.6\"/><path d=\"M150 150 C168 140 188 138 204 138\" stroke=\"#FFFFFF\" stroke-opacity=\"0.85\" stroke-width=\"7\" stroke-linecap=\"round\" fill=\"none\"/><rect x=\"300\" y=\"230\" width=\"8\" height=\"130\" rx=\"4\" fill-opacity=\"0.45\"/></g><path d=\"M136 112 L264 112 L264 122 C264 146 320 150 320 198 L320 398 C320 428 300 446 268 446 L132 446 C100 446 80 428 80 398 L80 198 C80 150 136 146 136 122 Z\" fill=\"none\" stroke=\"#110E08\" stroke-opacity=\"0.14\" stroke-width=\"2\"/><path d=\"M96 436 C140 446 260 446 304 436\" fill=\"none\" stroke=\"#110E08\" stroke-opacity=\"0.18\" stroke-width=\"2.5\" stroke-linecap=\"round\"/><path d=\"M128 104 L272 104 L272 120 C272 138 330 142 330 196 L330 400 C330 436 306 456 270 456 L130 456 C94 456 70 436 70 400 L70 196 C70 142 128 138 128 120 Z\" fill=\"none\" stroke=\"#110E08\" stroke-width=\"5\" stroke-linejoin=\"round\"/><rect x=\"112\" y=\"80\" width=\"176\" height=\"30\" rx=\"12\" fill=\"#EAF1EE\" fill-opacity=\"0.8\" stroke=\"#110E08\" stroke-width=\"5\"/><rect x=\"126\" y=\"88\" width=\"26\" height=\"6\" rx=\"3\" fill=\"#FFFFFF\"/><rect x=\"164\" y=\"90\" width=\"72\" height=\"10\" rx=\"5\" fill=\"#110E08\"/><rect x=\"150\" y=\"196\" width=\"100\" height=\"40\" rx=\"12\" fill=\"#CCFF00\" stroke=\"#110E08\" stroke-width=\"4\"/><g transform=\"translate(162.5 226)\"><g transform=\"translate(0.00 0) scale(0.028)\"><path d=\"M270 0V-600H90V-700H550V-600H370V0Z\" fill=\"#110E08\"/></g><g transform=\"translate(18.76 0) scale(0.028)\"><path d=\"M90 0V-100H270V-600H90V-700H550V-600H370V-100H550V0Z\" fill=\"#110E08\"/></g><g transform=\"translate(37.52 0) scale(0.028)\"><path d=\"M70 0V-700H530V-400H170V0ZM170 -500H430V-600H170Z\" fill=\"#110E08\"/></g><g transform=\"translate(55.16 0) scale(0.028)\"><path d=\"M60 -200H160Q160 -173 184.5 -150.0Q209 -127 250.0 -113.5Q291 -100 340 -100Q390 -100 430.5 -113.5Q471 -127 495.5 -150.0Q520 -173 520 -200V-300Q520 -328 495.5 -350.5Q471 -373 430.5 -386.5Q390 -400 340 -400H60V-500Q60 -555 97.5 -600.5Q135 -646 199.0 -673.0Q263 -700 340 -700Q418 -700 481.5 -673.0Q545 -646 582.5 -600.5Q620 -555 620 -500H520Q520 -528 495.5 -550.5Q471 -573 430.5 -586.5Q390 -600 340 -600Q291 -600 250.0 -586.5Q209 -573 184.5 -550.5Q160 -528 160 -500H340Q418 -500 481.5 -473.0Q545 -446 582.5 -400.5Q620 -355 620 -300V-200Q620 -145 582.5 -99.5Q545 -54 481.5 -27.0Q418 0 340 0Q263 0 199.0 -27.0Q135 -54 97.5 -99.5Q60 -145 60 -200Z\" fill=\"#110E08\"/></g></g>";
const COIN = "<image href=\"/brand/wif-coin-256.png\" x=\"-34.00\" y=\"-34.00\" width=\"68.00\" height=\"68.00\"/>";
const K = {"CYCLE": 2.8, "FALL": 0.6, "Y0": -34, "Y1": 98, "WOB": 0.95, "AMP": 2.6, "FREQ": 2.4, "CHIP": [0.62, 0.26], "PLUS": [0.62, 0.8]};

export type TipJarProps = {
  /** Rendered width in px (height = width * 1.35). */
  size?: number;
  /** Loop the drop / wobble / tick animation. */
  animate?: boolean;
  /** Starting tip count shown in the chip. */
  count?: number;
  /** Show the counter chip (defaults to the value of animate). */
  showCounter?: boolean;
  unit?: string;
  /** Where the official token PNGs are served from. */
  assetBase?: string;
  /** Called on each coin drop with the new count. */
  onTick?: (count: number) => void;
  title?: string;
  className?: string;
  style?: CSSProperties;
};

const INK = '#110E08';
const NEON = '#CCFF00';

export function TipJar({
  size = 240, animate = false, count = 0, showCounter, unit = '$wif', assetBase = '/brand',
  onTick, title = 'tip jar', className, style,
}: TipJarProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const jarRef = useRef<SVGGElement>(null);
  const coinWrapRef = useRef<SVGGElement>(null);
  const coinRef = useRef<SVGGElement>(null);
  const chipRef = useRef<SVGGElement>(null);
  const plusRef = useRef<SVGTextElement>(null);
  const [n, setN] = useState(count);
  const [reduced, setReduced] = useState(false);
  const tickRef = useRef(onTick);
  tickRef.current = onTick;

  useEffect(() => setN(count), [count]);
  useEffect(() => {
    const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);

  const playing = animate && !reduced;
  const fix = (s: string) => s.split('__ID__').join(uid).split('/brand/').join(`${assetBase.replace(/\/$/, '')}/`);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let start = 0;
    let lastCycle = -1;
    const frame = (now: number) => {
      if (!start) start = now;
      const el = (now - start) / 1000;
      const cyc = Math.floor(el / K.CYCLE);
      const t = el - cyc * K.CYCLE;
      if (cyc !== lastCycle && t >= K.CHIP[0]) {
        lastCycle = cyc;
        setN((v) => { const nv = v + 1; tickRef.current?.(nv); return nv; });
      }
      let y = K.Y1, sx = 1, op = 0;
      if (t < K.FALL) { const u = t / K.FALL; y = K.Y0 + (K.Y1 - K.Y0) * u * u; sx = 0.78 + 0.22 * Math.cos(t * 11); op = Math.min(1, t / 0.08); }
      const w = t - K.FALL;
      const rot = w >= 0 && w <= K.WOB ? K.AMP * Math.exp(-4 * w) * Math.sin(2 * Math.PI * K.FREQ * w) * (1 - w / K.WOB) : 0;
      const c = (t - K.CHIP[0]) / K.CHIP[1];
      const cs = c >= 0 && c <= 1 ? 1 + 0.14 * Math.sin(Math.PI * c) : 1;
      const p = (t - K.PLUS[0]) / K.PLUS[1];
      coinRef.current?.setAttribute('transform', `translate(200 ${y.toFixed(2)}) scale(${sx.toFixed(4)} 1)`);
      coinWrapRef.current?.setAttribute('opacity', op.toFixed(3));
      jarRef.current?.setAttribute('transform', `rotate(${rot.toFixed(3)} 200 456)`);
      chipRef.current?.setAttribute('transform', `translate(336 -18) scale(${cs.toFixed(4)})`);
      if (plusRef.current) {
        const on = p >= 0 && p <= 1;
        plusRef.current.setAttribute('opacity', on ? (1 - p).toFixed(3) : '0');
        plusRef.current.setAttribute('y', (30 - (on ? p * 22 : 0)).toFixed(2));
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const counter = showCounter ?? animate;
  const a11y = title ? { role: 'img' as const, 'aria-label': counter ? `${title}: ${n} ${unit}` : title } : { 'aria-hidden': true as const };
  return (
    <svg viewBox="0 -40 400 540" width={size} height={size * 1.35} className={className} style={{ display: 'block', ...style }} {...a11y}>
      {title ? <title>{title}</title> : null}
      {playing ? (
        <>
          <clipPath id={`${uid}-slot`}><rect x={0} y={-80} width={400} height={175} /></clipPath>
          <g ref={coinWrapRef} clipPath={`url(#${uid}-slot)`} opacity={0}>
            <g ref={coinRef} transform={`translate(200 ${K.Y0})`} dangerouslySetInnerHTML={{ __html: fix(COIN) }} />
          </g>
          <g ref={jarRef} dangerouslySetInnerHTML={{ __html: fix(BODY_ANIM) }} />
        </>
      ) : (
        <g dangerouslySetInnerHTML={{ __html: fix(BODY_STATIC) }} />
      )}
      {counter ? (
        <>
          <g ref={chipRef} transform="translate(336 -18)">
            <rect x={-56} y={-16} width={112} height={32} rx={16} fill={NEON} stroke={INK} strokeWidth={3} />
            <text x={0} y={6} textAnchor="middle" fontWeight={700} fontSize={16} fill={INK} style={{ fontVariantNumeric: 'tabular-nums' }}>{`${n} ${unit}`}</text>
          </g>
          <text ref={plusRef} x={336} y={30} opacity={0} textAnchor="middle" fontWeight={700} fontSize={18} fill={INK}>+1</text>
        </>
      ) : null}
    </svg>
  );
}

export default TipJar;
