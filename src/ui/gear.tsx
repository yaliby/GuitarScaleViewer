import type { ReactNode, SelectHTMLAttributes, InputHTMLAttributes, ButtonHTMLAttributes } from 'react';

/**
 * Panel primitives for the gear chrome. Everything here obeys one light model: the panel is lit
 * from above, so raised things carry a highlight on their top edge and a shadow below, and
 * recessed things carry the reverse. Colour is reserved for LEDs and the root-note accent.
 */

export type LedTone = 'live' | 'hold' | 'fault' | 'data' | 'off';

const LED_COLOR: Record<Exclude<LedTone, 'off'>, string> = {
  live: 'var(--led-live)',
  hold: 'var(--led-hold)',
  fault: 'var(--led-fault)',
  data: 'var(--led-data)',
};

/** A panel status lamp. `off` renders the unlit lens so the row never reflows when state changes. */
export function Led({
  tone,
  pulse = false,
  size = 7,
  label,
}: {
  tone: LedTone;
  /** Slow breathe, for "working on it" states only. */
  pulse?: boolean;
  size?: number;
  /** Screen-reader text; the lamp itself is decorative without it. */
  label?: string;
}) {
  const lit = tone !== 'off';
  const color = lit ? LED_COLOR[tone] : '#26262c';
  return (
    <span
      className={`relative inline-block shrink-0 rounded-full ${pulse && lit ? 'animate-pulse' : ''}`}
      style={{
        width: size,
        height: size,
        background: lit
          ? `radial-gradient(circle at 35% 30%, #fff 0%, ${color} 42%, ${color} 70%, rgba(0,0,0,0.55) 100%)`
          : 'radial-gradient(circle at 35% 30%, #3a3a42 0%, #1c1c21 60%, #0a0a0c 100%)',
        boxShadow: lit
          ? `0 0 ${size * 1.1}px ${color}, 0 0 ${size * 2.4}px ${color}66, inset 0 0 1px rgba(255,255,255,0.5)`
          : 'inset 0 1px 1px rgba(0,0,0,0.8), 0 1px 0 rgba(255,255,255,0.05)',
      }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

/** Engraved legend text. Use for every field label — never a shouty uppercase span. */
export function Legend({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`legend ${className}`}>{children}</span>;
}

/** A panel screw. Purely a corner detail; four of these is plenty for the whole app. */
export function Screw({ className = '' }: { className?: string }) {
  return <span className={`gear-screw pointer-events-none absolute h-[7px] w-[7px] rounded-full ${className}`} />;
}

/** A raised faceplate section. */
export function Panel({
  children,
  className = '',
  screws = false,
  ...rest
}: { children: ReactNode; className?: string; screws?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`gear-panel relative rounded-[5px] ${className}`} {...rest}>
      {screws ? (
        <>
          <Screw className="left-2 top-2" />
          <Screw className="right-2 top-2" />
          <Screw className="bottom-2 left-2" />
          <Screw className="bottom-2 right-2" />
        </>
      ) : null}
      {children}
    </div>
  );
}

/** A milled-out well: anything that should read as cut into the face. */
export function Well({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`gear-well rounded-[4px] ${className}`}>{children}</div>;
}

/** Hairline join between two plates. */
export function Seam({ className = '' }: { className?: string }) {
  return <div className={`gear-seam h-px w-full ${className}`} aria-hidden="true" />;
}

type ButtonTone = 'default' | 'primary' | 'danger';

const BUTTON_TONE: Record<ButtonTone, string> = {
  default: 'text-gear-text/85 hover:text-white',
  primary: 'text-[#1a1206]',
  danger: 'text-[#f2b7b9] hover:text-[#ffd7d8]',
};

/**
 * A momentary push button: it sits proud of the panel and physically depresses on press.
 * `primary` is the one amber-capped button on the panel — reserve it for the main action.
 */
export function GearButton({
  children,
  tone = 'default',
  className = '',
  disabled,
  ...rest
}: { children: ReactNode; tone?: ButtonTone } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const surface =
    tone === 'primary'
      ? 'bg-[linear-gradient(180deg,#f7be55_0%,#efa227_48%,#c07d12_100%)]'
      : 'bg-[linear-gradient(180deg,#2a2a31_0%,#212127_48%,#171a1c_100%)]';
  return (
    <button
      type="button"
      disabled={disabled}
      className={`relative select-none rounded-[3px] px-3 py-[7px] text-[11px] font-bold uppercase tracking-[0.1em] shadow-raised transition-[transform,box-shadow,filter] duration-75 ${surface} ${BUTTON_TONE[tone]} ${
        disabled
          ? 'cursor-not-allowed opacity-35 saturate-0'
          : 'hover:brightness-110 active:translate-y-px active:shadow-inset active:brightness-95'
      } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gear-accent/70 focus-visible:ring-offset-1 focus-visible:ring-offset-gear-chassis ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * A latching toggle. Engaged reads as pressed-in and lit; disengaged sits proud and dark.
 * Unlike a push button the state is the whole point, so the depression persists.
 */
export function GearToggle({
  children,
  engaged,
  className = '',
  ...rest
}: { children: ReactNode; engaged: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-pressed={engaged}
      className={`relative flex select-none items-center justify-center gap-1.5 rounded-[3px] px-2.5 py-[7px] text-[10px] font-bold uppercase leading-none tracking-[0.11em] transition-[box-shadow,color,background,transform] duration-100 ${
        engaged
          ? 'bg-[linear-gradient(180deg,#121216_0%,#17171c_100%)] text-gear-accent shadow-inset'
          : 'bg-[linear-gradient(180deg,#2a2a31_0%,#212127_48%,#171a1c_100%)] text-gear-engrave shadow-raised hover:text-gear-legend hover:brightness-110 active:translate-y-px'
      } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gear-accent/70 ${className}`}
      {...rest}
    >
      <Led tone={engaged ? 'hold' : 'off'} size={5} />
      {children}
    </button>
  );
}

/** A select sunk into the panel, with its own engraved chevron. */
export function GearSelect({
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <div className="gear-well relative rounded-[4px]">
      <select
        className={`gear-select w-full min-w-0 cursor-pointer truncate bg-transparent py-[7px] pl-2.5 pr-7 text-[13px] font-medium text-gear-text outline-none focus-visible:text-white ${className}`}
        {...rest}
      >
        {children}
      </select>
      <svg
        viewBox="0 0 10 6"
        className="pointer-events-none absolute right-2.5 top-1/2 h-[5px] w-[9px] -translate-y-1/2 fill-gear-engrave"
        aria-hidden="true"
      >
        <path d="M0 0h10L5 6z" />
      </svg>
    </div>
  );
}

/** A text field sunk into the panel. */
export function GearInput({
  className = '',
  invalid = false,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <div
      className="gear-well rounded-[4px]"
      style={invalid ? { boxShadow: 'var(--bevel-inset), inset 0 0 0 1px rgba(242,85,90,0.55)' } : undefined}
    >
      <input
        className={`w-full min-w-0 bg-transparent px-2.5 py-[7px] text-[13px] font-medium text-gear-text outline-none placeholder:text-gear-engrave/60 ${className}`}
        {...rest}
      />
    </div>
  );
}

/** How many rectangles a meter is milled into. Exported so a caption can quote the count. */
export const METER_SEGMENTS = 14;

/** `--gear-accent`, spelled out: an outline needs an alpha the CSS variable cannot carry. */
const ACCENT_HEX = '#f0a52a';

/** Keep in step with the `gap-[2px]` on the meter below — the gate marker is placed off it. */
const SEGMENT_GAP_PX = 2;

/**
 * How many of a meter's rectangles a 0–1 reading lights. The Apply gate quotes this, so the
 * number a caption gives is the number of bars actually drawn, not a second rounding of its own.
 */
export function litSegments(value: number, segments: number = METER_SEGMENTS): number {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return Math.round(clamped * segments);
}

/** Where the boundary after `count` bars falls: the middle of the gap that follows them. */
function gateOffset(count: number, segments: number): string {
  if (count >= segments) {
    return '100%';
  }
  const bars = `(100% - ${(segments - 1) * SEGMENT_GAP_PX}px)`;
  return `calc(${bars} * ${count / segments} + ${SEGMENT_GAP_PX * count - SEGMENT_GAP_PX / 2}px)`;
}

/**
 * A segmented bar meter, read like a VU strip. Segments light left-to-right and shift from the
 * live tone into the accent as the reading approaches full, so a glance gives a level without a number.
 *
 * `gate` puts a second reading on the same strip: the level something has been asked to reach
 * before it may act. Bars below it that are not lit are outlined rather than left dark, so the
 * gate can be counted in rectangles while the control that sets it is being dragged.
 */
export function SignalMeter({
  value,
  segments = METER_SEGMENTS,
  className = '',
  label,
  gate = null,
  gateLive = false,
}: {
  /** 0–1. Values outside the range are clamped. */
  value: number;
  segments?: number;
  className?: string;
  label?: string;
  /** 0–1, or null for a strip with no gate on it. */
  gate?: number | null;
  /** The gate is being set right now, so draw it at full strength. */
  gateLive?: boolean;
}) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const litCount = litSegments(clamped, segments);
  const gateCount = gate == null ? 0 : litSegments(gate, segments);
  return (
    <div
      className={`relative flex h-[7px] min-w-0 gap-[2px] ${className}`}
      role="meter"
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      {Array.from({ length: segments }, (_, i) => {
        const lit = i < litCount;
        /* Unlit, but the gate wants it lit: the bars a player is counting off on the slider. */
        const owed = !lit && i < gateCount;
        const ratio = i / Math.max(1, segments - 1);
        const color = ratio > 0.78 ? 'var(--gear-accent)' : 'var(--led-live)';
        return (
          <span
            key={i}
            data-lit={lit || undefined}
            data-owed={owed || undefined}
            className="flex-1 rounded-[1px] transition-[background,box-shadow] duration-150"
            style={{
              background: lit ? color : '#1b1b20',
              boxShadow: lit
                ? `0 0 5px ${color}99`
                : owed
                  ? `inset 0 0 0 1px ${ACCENT_HEX}${gateLive ? 'cc' : '59'}`
                  : 'inset 0 1px 1px rgba(0,0,0,0.8)',
            }}
          />
        );
      })}
      {gateCount > 0 ? (
        <span
          className="pointer-events-none absolute -top-1 -bottom-1 w-px -translate-x-1/2 transition-[left,opacity] duration-150"
          style={{
            left: gateOffset(gateCount, segments),
            background: ACCENT_HEX,
            opacity: gateLive ? 1 : 0.5,
          }}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
