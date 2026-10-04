interface AppPreviewProps {
  title?: string;
  body: string;
  locale: string;
  caption?: string;
}

export function AppPreview({ title = "Order confirmation", body, locale, caption }: AppPreviewProps) {
  return (
    <div data-testid="app-preview" className="bg-surface-container-low p-space-md rounded shadow-[4px_4px_0px_#00170b]">
      <div className="flex items-center justify-between mb-space-sm">
        <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">
          In-app preview (CSS mock)
        </span>
        <span className="font-label-sm text-label-sm uppercase bg-surface-container-highest px-space-xs py-0.5 rounded">
          {locale}
        </span>
      </div>
      <div className="mx-auto w-full max-w-[320px] bg-surface-container-lowest border border-outline-variant rounded overflow-hidden">
        <div className="bg-primary-container text-inverse-on-surface px-space-md py-space-sm flex items-center justify-between">
          <span className="font-label-md text-label-md uppercase">Preview storefront</span>
          <span className="font-label-sm text-label-sm">{locale}</span>
        </div>
        <div className="p-space-md flex flex-col gap-space-sm">
          <p className="font-title-md text-title-md text-primary">{title}</p>
          <p className="font-body-sm text-body-sm text-on-surface-variant">Order #LB-0042</p>
          <div className="bg-surface-container-low p-space-sm rounded border-l-4 border-l-secondary-container">
            <p className="font-title-md text-title-md text-primary">{body}</p>
          </div>
          <button
            type="button"
            className="w-full py-space-sm bg-secondary-container text-on-secondary-container font-label-md text-label-md uppercase"
            disabled
          >
            Continue
          </button>
        </div>
      </div>
      {caption ? <p className="mt-space-sm font-body-sm text-body-sm text-on-surface-variant">{caption}</p> : null}
    </div>
  );
}
