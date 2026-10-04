export function BrandLogo({ className = "h-8 w-auto" }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 60" fill="none" className={className} aria-hidden>
      <rect x="6" y="10" width="16" height="16" fill="#FF5500" />
      <rect x="22" y="10" width="16" height="16" fill="#0F2D1E" />
      <rect x="6" y="26" width="16" height="16" fill="#D4F46B" />
      <rect x="22" y="26" width="16" height="16" fill="#FF5500" />
      <rect x="38" y="26" width="10" height="10" fill="#7CE3EB" />
      <text
        x="60"
        y="36"
        fontFamily="'Space Grotesk', system-ui, sans-serif"
        fontWeight="900"
        fontSize="24"
        letterSpacing="-0.04em"
        fill="#0F2D1E"
      >
        LOCALE
        <tspan fill="#FF5500">BOUNTY</tspan>
      </text>
      <circle cx="218" cy="22" r="3.5" fill="#D4F46B" />
    </svg>
  );
}
