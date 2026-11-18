type DeveloperCreditProps = {
  className?: string;
};

const externalLinkClasses =
  "rounded-sm text-slate-300 underline decoration-white/15 underline-offset-4 transition hover:text-emerald-200 hover:decoration-emerald-300/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70";

export function DeveloperCredit({ className = "" }: DeveloperCreditProps) {
  return (
    <footer
      className={`border-t border-white/[0.07] bg-[#080d15]/95 px-4 py-4 text-center text-[11px] text-slate-500 backdrop-blur-xl ${className}`}
      aria-label="Developer credits"
    >
      <div className="mx-auto flex max-w-[1600px] flex-col items-center justify-center gap-2 sm:flex-row sm:flex-wrap sm:gap-x-3 sm:gap-y-1">
        <span>
          Developed by:{" "}
          <a
            className={externalLinkClasses}
            href="https://entouraged-sam.vercel.app/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Entouraged.sam
          </a>
        </span>
        <span className="hidden text-slate-700 sm:inline" aria-hidden="true">·</span>
        <span>
          GitHub:{" "}
          <a
            className={externalLinkClasses}
            href="https://github.com/LegendGod01"
            target="_blank"
            rel="noopener noreferrer"
          >
            github.com/LegendGod01
          </a>
        </span>
        <span className="hidden text-slate-700 sm:inline" aria-hidden="true">·</span>
        <span>
          Bio:{" "}
          <a
            className={externalLinkClasses}
            href="https://entouraged-sam.vercel.app/"
            target="_blank"
            rel="noopener noreferrer"
          >
            entouraged-sam.vercel.app
          </a>
        </span>
      </div>
    </footer>
  );
}
