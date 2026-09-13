"use client";

/** Shared aviation-panel UI primitives. */

import type { ReactNode } from "react";

export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`border border-hairline bg-panel/92 backdrop-blur-sm ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-3">
      <span className="text-2xs uppercase tracking-[0.22em] text-osd-dim">
        {children}
      </span>
      <span className="h-px flex-1 bg-hairline" />
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled = false,
  tone = "default",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "default" | "accent" | "danger";
  className?: string;
}) {
  const tones = {
    default:
      "border-hairline-bright text-osd hover:border-cyan hover:text-cyan hover:bg-cyan/5",
    accent:
      "border-accent/70 text-accent hover:border-accent hover:bg-accent/10",
    danger:
      "border-danger/50 text-danger hover:border-danger hover:bg-danger/10",
  } as const;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`group relative w-full border px-5 py-3 text-left text-sm uppercase tracking-[0.18em] transition-colors duration-150 disabled:cursor-not-allowed disabled:border-hairline disabled:text-osd-faint disabled:hover:bg-transparent ${
        disabled ? "border-hairline text-osd-faint" : tones[tone]
      } ${className}`}
    >
      {children}
    </button>
  );
}

/** `gap-1.5`, in the units the track arithmetic below needs it in. */
const GAP_REM = 0.375;
/**
 * A label and a hint character, each as a fraction of a `ch`.
 *
 * `ch` is measured on the container at the root size, and both lines are set
 * smaller than that: the label is `text-xs` with `tracking-[0.1em]`, the hint
 * `text-2xs` with none.
 */
const LABEL_CH = 0.875;
const HINT_CH = 0.72;

/** The longest run in a hint that cannot be broken across two lines. */
function longestWord(text: string): number {
  return text
    .split(/\s+/)
    .reduce((longest, word) => Math.max(longest, word.length), 0);
}

/** One cell of an option group: what it says, and what picking it means. */
interface OptionEntry<T extends string | number> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * The tracks an option group is laid out on.
 *
 * `columns` is what the group wants, not what it always gets. Both the label
 * and the hint under it are often a single word — PHOTOREALISTIC,
 * Stratocumulus — and a cell narrower than the word would either break it or
 * let it run out of its own box, so a track never goes under the longest word
 * in the group and a group laid out in a narrow column drops to fewer of them
 * instead. The font is monospace, so `ch` measures it.
 */
function optionTracks<T extends string | number>(
  options: readonly OptionEntry<T>[],
  columns: number,
): string {
  const widest = options.reduce((longest, option) => {
    const hint = option.hint ? longestWord(option.hint) : 0;
    return Math.max(longest, option.label.length * LABEL_CH, hint * HINT_CH);
  }, 0);
  const word = `calc(${widest.toFixed(2)}ch + 1.6rem)`;
  const share = `calc((100% - ${(columns - 1) * GAP_REM}rem) / ${columns})`;
  return `repeat(auto-fit, minmax(min(100%, max(${word}, ${share})), 1fr))`;
}

/** One cell, drawn the same whether the group takes one answer or several. */
function OptionCell<T extends string | number>({
  option,
  selected,
  onPick,
}: {
  option: OptionEntry<T>;
  selected: boolean;
  onPick: (value: T) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(option.value)}
      aria-pressed={selected}
      className={`border px-3 py-2 text-left transition-colors duration-150 ${
        selected
          ? "border-cyan/70 bg-cyan/10 text-cyan"
          : "border-hairline text-osd-dim hover:border-hairline-bright hover:text-osd"
      }`}
    >
      {/* A label with no space in it — PHOTOREALISTIC — has to be
          allowed to break, or it runs out of a narrow column. */}
      <span className="block text-xs tracking-[0.1em] break-words uppercase">
        {option.label}
      </span>
      {option.hint ? (
        <span className="mt-0.5 block text-2xs text-osd-faint normal-case tracking-normal">
          {option.hint}
        </span>
      ) : null}
    </button>
  );
}

export function OptionGroup<T extends string | number>({
  options,
  value,
  onChange,
  columns = 3,
}: {
  options: readonly OptionEntry<T>[];
  value: T;
  onChange: (value: T) => void;
  columns?: number;
}) {
  return (
    <div
      className="grid gap-1.5"
      style={{ gridTemplateColumns: optionTracks(options, columns) }}
    >
      {options.map((option) => (
        <OptionCell
          key={String(option.value)}
          option={option}
          selected={option.value === value}
          onPick={onChange}
        />
      ))}
    </div>
  );
}

/**
 * The same group, for a question that takes more than one answer.
 *
 * Every cell is a toggle rather than a choice, so a selection is built up
 * rather than replaced. What an empty selection means is the caller's
 * business: `onToggle` is told which cell was pressed and decides.
 */
export function MultiOptionGroup<T extends string | number>({
  options,
  values,
  onToggle,
  columns = 3,
}: {
  options: readonly OptionEntry<T>[];
  values: readonly T[];
  onToggle: (value: T) => void;
  columns?: number;
}) {
  return (
    <div
      className="grid gap-1.5"
      style={{ gridTemplateColumns: optionTracks(options, columns) }}
    >
      {options.map((option) => (
        <OptionCell
          key={String(option.value)}
          option={option}
          selected={values.includes(option.value)}
          onPick={onToggle}
        />
      ))}
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  tone = "cyan",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  /**
   * The accent the handle carries. Cyan is the default and means nothing in
   * particular; a panel that stacks two kinds of control — cloud decks and
   * wind levels, which look identical and edit completely different things —
   * uses a second tone so a slider can be told apart at a glance.
   */
  tone?: "cyan" | "amber";
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between">
        <span className="text-2xs uppercase tracking-[0.14em] text-osd-dim">
          {label}
        </span>
        <span className="text-xs tabular-nums text-osd">
          {format ? format(value) : value.toFixed(2)}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className={`h-1 w-full cursor-pointer appearance-none rounded-full bg-hairline ${
          tone === "amber" ? "accent-amber" : "accent-cyan"
        }`}
      />
    </label>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between border border-hairline px-3 py-2 text-left transition-colors hover:border-hairline-bright"
    >
      <span className="text-2xs uppercase tracking-[0.14em] text-osd-dim">
        {label}
      </span>
      <span
        className={`text-xs uppercase tracking-[0.14em] ${
          checked ? "text-lime" : "text-osd-faint"
        }`}
      >
        {checked ? "On" : "Off"}
      </span>
    </button>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.0001,
  suffix,
  invalid = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  invalid?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-2xs uppercase tracking-[0.14em] text-osd-dim">
        {label}
      </span>
      <span className="relative block">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => onChange(event.target.value)}
          className={`w-full border bg-void px-3 py-2 text-sm tabular-nums text-osd outline-none transition-colors focus:border-cyan ${
            invalid ? "border-danger" : "border-hairline"
          }`}
        />
        {suffix ? (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-2xs text-osd-faint">
            {suffix}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  rows = 1,
  invalid = false,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** More than one turns the field into a textarea. */
  rows?: number;
  invalid?: boolean;
  mono?: boolean;
}) {
  const className = `w-full resize-none border bg-void px-3 py-2 text-sm text-osd outline-none transition-colors focus:border-cyan ${
    mono ? "font-mono tracking-tight" : ""
  } ${invalid ? "border-danger" : "border-hairline"}`;

  return (
    <label className="block">
      <span className="mb-1 block text-2xs uppercase tracking-[0.14em] text-osd-dim">
        {label}
      </span>
      {rows > 1 ? (
        <textarea
          value={value}
          rows={rows}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className={className}
        />
      ) : (
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className={className}
        />
      )}
    </label>
  );
}

/**
 * A colour, picked in the browser's own picker.
 *
 * The native control again, for the same reason as the date field: every
 * platform already has a colour picker its users know, and a hand-rolled wheel
 * would be a worse one. The hex is shown beside it because that is how a
 * colour is written down, copied, and told to somebody else.
 */
export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  /** `#rrggbb`; anything else is what the picker will make of it. */
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-2xs uppercase tracking-[0.14em] text-osd-dim">
        {label}
      </span>
      <span className="flex items-center gap-3 border border-hairline bg-void px-3 py-2 transition-colors focus-within:border-cyan">
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-6 w-8 shrink-0 cursor-pointer appearance-none border border-hairline-bright bg-transparent p-0 outline-none [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
        />
        <span className="text-xs uppercase tabular-nums tracking-[0.16em] text-osd">
          {value}
        </span>
      </span>
    </label>
  );
}

/**
 * A date or a time, entered in the browser's own picker.
 *
 * The native control is used rather than a pair of number fields because it
 * already knows what a month is worth and which days a February has, and it
 * hands back exactly the `YYYY-MM-DD` and `HH:MM` the simulation parses. It is
 * styled to match the rest of the panel, down to inverting the picker glyph
 * that would otherwise be black on black.
 */
export function DateTimeField({
  label,
  kind,
  value,
  onChange,
  invalid = false,
}: {
  label: string;
  kind: "date" | "time";
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-2xs uppercase tracking-[0.14em] text-osd-dim">
        {label}
      </span>
      <input
        type={kind}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`w-full border bg-void px-3 py-2 text-sm tabular-nums text-osd outline-none transition-colors focus:border-cyan [&::-webkit-calendar-picker-indicator]:invert ${
          invalid ? "border-danger" : "border-hairline"
        }`}
      />
    </label>
  );
}

export function KeyCap({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[2.2rem] items-center justify-center border border-hairline-bright bg-panel-raised px-2 py-1 text-2xs uppercase tracking-widest text-osd">
      {children}
    </kbd>
  );
}

/**
 * Lays a menu's sections out in as many columns as the window has room for.
 *
 * The simulator is flown on a desktop, so a menu that stacks every section
 * into one narrow strip spends the width it has on empty margins and makes the
 * pilot scroll for the setting at the bottom. Here the sections flow into
 * columns instead: the browser fits as many `minWidth`-wide columns as the
 * container allows and drops back to one when it cannot, which keeps the
 * usual menus on a single screen without any breakpoint being hard-coded.
 *
 * Sections are kept whole, so a heading never ends up at the foot of one
 * column with its controls at the top of the next, and the gap below each one
 * comes from here rather than from the sections themselves.
 */
export function MenuColumns({
  children,
  minWidth = "22rem",
  className = "",
}: {
  children: ReactNode;
  /** Narrowest a column may become before the layout gives one up. */
  minWidth?: string;
  className?: string;
}) {
  return (
    <div
      className={`gap-x-10 [&>*]:mb-8 [&>*]:break-inside-avoid ${className}`}
      style={{ columnWidth: minWidth }}
    >
      {children}
    </div>
  );
}
