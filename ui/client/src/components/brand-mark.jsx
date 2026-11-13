// Artrios mark: an "A" drawn by three linked nodes (the trio) inside a tilted orbit, as in the Brain rings.
// Inline and transparent so it follows the theme (var(--primary)); public/favicon.svg is the boxed tab icon.
export function BrandMark({ size = 28, className = "", title = "Artrios" }) {
  return (
    // Inline size: menu buttons shrink every nested svg to 16 px with a class, and a style wins over it.
    <svg viewBox="0 0 64 64" width={size} height={size} style={{ width: size, height: size }} className={className} role="img" aria-label={title}>
      <ellipse cx="32" cy="37" rx="27" ry="9" transform="rotate(-16 32 37)" fill="none" stroke="var(--primary)" strokeOpacity="0.45" strokeWidth="2.6" />
      <path d="M32 12 L15 51 M32 12 L49 51 M23 38 H41" fill="none" stroke="var(--primary)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="32" cy="12" r="7" fill="var(--primary)" opacity="0.25" />
      <circle cx="32" cy="12" r="5" fill="var(--primary)" />
      <circle cx="15" cy="51" r="5.4" fill="var(--primary)" />
      <circle cx="49" cy="51" r="5.4" fill="var(--primary)" />
    </svg>
  );
}
