/**
 * The burn402 flame, drawn rather than typed so it can move: three flat layers that sway from the base
 * out of step with each other (motion is in globals.css). `lit` burns faster, for when an agent is at
 * work. Decorative everywhere it appears; reduced motion holds it still.
 */
export function Flame({ size = 18, lit = false, className = "" }: { size?: number; lit?: boolean; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={`flame ${lit ? "flame-lit" : ""} ${className}`}
    >
      <path
        className="flame-a"
        fill="var(--flame-outer)"
        d="M13.1 1C14 6.3 18.2 8 18.7 13.3 19.3 18.1 15.9 22 12 22 8.1 22 4.7 18.4 5.3 13.6 5.6 10.8 7.5 8.8 8.6 6.6 9.5 9.4 10.9 10.5 12 11.4 11.4 7.4 12 3.8 13.1 1Z"
      />
      <path
        className="flame-b"
        fill="var(--flame-mid)"
        d="M12.6 9.6C13 12.4 16 13.5 16 16.7 16 19.7 14.2 21.6 12 21.6 9.8 21.6 8 19.8 8 17 8 15.2 9 14 9.7 12.9 10.1 14.2 10.8 14.8 11.6 15.1 11.4 13 11.8 11.1 12.6 9.6Z"
      />
      <path
        className="flame-c"
        fill="var(--flame-core)"
        d="M12 15.4C13 16.7 14 17.6 14 19.1 14 20.5 13.1 21.4 12 21.4 10.9 21.4 10 20.5 10 19.1 10 17.6 11.1 16.7 12 15.4Z"
      />
    </svg>
  );
}
