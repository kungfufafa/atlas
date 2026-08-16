import type { PresentationPreview } from "@atlas/core";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Download01Icon,
  Note01Icon,
  Presentation01Icon,
} from "hugeicons-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export function PresentationViewer({
  preview,
  downloadUrl,
}: {
  preview: PresentationPreview;
  downloadUrl: string;
}) {
  const slides = preview.slides || [];
  const totalSlides = Math.max(1, slides.length);
  const [currentSlideIndex, setCurrentSlideIndex] = useState(0);
  const [showNotes, setShowNotes] = useState(false);

  const currentSlide = slides[currentSlideIndex] ||
    slides[0] || {
      slideIndex: 0,
      title: preview.title || preview.filename,
    };

  function handlePrev() {
    setCurrentSlideIndex((idx) => Math.max(0, idx - 1));
  }

  function handleNext() {
    setCurrentSlideIndex((idx) => Math.min(totalSlides - 1, idx + 1));
  }

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        setCurrentSlideIndex((idx) => Math.max(0, idx - 1));
      } else if (
        e.key === "ArrowRight" ||
        e.key === "PageDown" ||
        e.key === " "
      ) {
        setCurrentSlideIndex((idx) => Math.min(totalSlides - 1, idx + 1));
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [totalSlides]);

  const isDarkCover =
    currentSlide.backgroundColor === "#0F172A" ||
    currentSlide.backgroundColor === "#000000" ||
    (currentSlideIndex === 0 && !currentSlide.backgroundColor);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-muted/20">
      {/* Top Toolbar */}
      <div className="flex items-center justify-between border-border border-b bg-card px-4 py-2 text-sm shadow-xs">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <Presentation01Icon className="size-4" />
          </div>
          <span className="truncate font-semibold text-foreground text-xs sm:text-sm">
            {preview.title || preview.filename}
          </span>
          <span className="rounded bg-muted px-2 py-0.5 font-medium text-[11px] text-muted-foreground">
            {totalSlides} slide{totalSlides === 1 ? "" : "s"}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {currentSlide.notes ? (
            <Button
              aria-label="Toggle speaker notes"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => setShowNotes((v) => !v)}
              size="sm"
              type="button"
              variant={showNotes ? "secondary" : "ghost"}
            >
              <Note01Icon className="size-3.5" />
              Notes
            </Button>
          ) : null}

          <div className="h-4 w-px bg-border" />

          <a
            aria-label="Download presentation"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 font-medium text-foreground text-xs shadow-2xs transition-colors hover:bg-accent hover:text-foreground"
            download={preview.filename}
            href={downloadUrl}
          >
            <Download01Icon className="size-3.5" />
            Download
          </a>
        </div>
      </div>

      {/* Main Slide Workspace */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left Slide Thumbnails Rail */}
        <aside className="w-56 shrink-0 overflow-y-auto border-border border-r bg-card/60 p-3">
          <h4 className="mb-2.5 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
            Slides ({totalSlides})
          </h4>
          <div className="space-y-2.5">
            {slides.map((slide, idx) => {
              const isSelected = idx === currentSlideIndex;
              const isThumbDark =
                slide.backgroundColor === "#0F172A" ||
                (idx === 0 && !slide.backgroundColor);

              return (
                <button
                  className={`group relative w-full rounded-lg border p-2 text-left transition-all ${
                    isSelected
                      ? "border-primary bg-primary/10 shadow-xs ring-1 ring-primary"
                      : "border-border/60 bg-background hover:border-border hover:shadow-2xs"
                  }`}
                  key={`thumb-${idx}`}
                  onClick={() => setCurrentSlideIndex(idx)}
                  type="button"
                >
                  <div
                    className={`flex aspect-[16/9] w-full flex-col justify-between overflow-hidden rounded p-2 ${
                      isThumbDark
                        ? "bg-slate-900 text-white"
                        : "bg-white text-slate-900"
                    } border border-border/40 shadow-2xs`}
                  >
                    <span className="line-clamp-1 font-bold text-[9px]">
                      {slide.title || `Slide ${idx + 1}`}
                    </span>
                    {slide.subtitle ? (
                      <span className="line-clamp-1 text-[8px] text-blue-500">
                        {slide.subtitle}
                      </span>
                    ) : null}
                    <div className="flex justify-end">
                      <span className="font-bold text-[8px] opacity-60">
                        {idx + 1}
                      </span>
                    </div>
                  </div>
                  <div className="mt-1 flex items-center justify-between px-0.5">
                    <span className="truncate font-medium text-[11px] text-foreground">
                      {slide.title || `Slide ${idx + 1}`}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Center Main Slide View */}
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 items-center justify-center p-4 sm:p-6">
            <div
              className={`relative flex aspect-[16/9] w-full max-w-4xl flex-col justify-between overflow-hidden rounded-xl border border-border/80 p-8 shadow-md transition-all sm:p-12 ${
                isDarkCover
                  ? "bg-slate-900 text-slate-100"
                  : "bg-white text-slate-900"
              }`}
              style={{
                backgroundColor:
                  currentSlide.backgroundColor ||
                  (isDarkCover ? "#0F172A" : "#FFFFFF"),
              }}
            >
              {/* Header: Title & Subtitle */}
              <div>
                {currentSlide.subtitle ? (
                  <p
                    className="font-bold text-blue-600 text-xs uppercase tracking-wider sm:text-sm dark:text-blue-400"
                    style={{ color: preview.themeColor || "#3B82F6" }}
                  >
                    {currentSlide.subtitle}
                  </p>
                ) : null}
                {currentSlide.title ? (
                  <h2
                    className={`mt-1 font-extrabold tracking-tight ${
                      currentSlide.layout === "title"
                        ? "my-auto text-center text-2xl sm:text-4xl"
                        : "text-xl sm:text-3xl"
                    }`}
                  >
                    {currentSlide.title}
                  </h2>
                ) : null}
              </div>

              {/* Body: Bullet Points, Text Blocks, or Tables */}
              <div className="my-auto space-y-4">
                {currentSlide.bulletPoints &&
                currentSlide.bulletPoints.length > 0 ? (
                  <ul className="space-y-2.5 sm:space-y-3.5">
                    {currentSlide.bulletPoints.map((point, pIdx) => (
                      <li
                        className="flex items-start gap-3 font-medium text-sm leading-relaxed opacity-90 sm:text-base"
                        key={`bullet-${pIdx}`}
                      >
                        <span
                          className="mt-1.5 size-2 shrink-0 rounded-full bg-blue-500"
                          style={{
                            backgroundColor: preview.themeColor || "#3B82F6",
                          }}
                        />
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {currentSlide.textBlocks &&
                currentSlide.textBlocks.length > 0 ? (
                  <div className="space-y-2">
                    {currentSlide.textBlocks.map((block, bIdx) => (
                      <p
                        className="font-normal text-sm leading-relaxed opacity-90 sm:text-base"
                        key={`text-${bIdx}`}
                      >
                        {block}
                      </p>
                    ))}
                  </div>
                ) : null}

                {/* Structured Table */}
                {currentSlide.table && currentSlide.table.headers.length > 0 ? (
                  <div className="overflow-hidden rounded-lg border border-border/50 shadow-2xs">
                    <table className="w-full text-left text-xs sm:text-sm">
                      <thead
                        className="bg-blue-600 text-white"
                        style={{
                          backgroundColor: preview.themeColor || "#3B82F6",
                        }}
                      >
                        <tr>
                          {currentSlide.table.headers.map((h, hIdx) => (
                            <th
                              className="px-3 py-2 font-bold"
                              key={`th-${hIdx}`}
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/40">
                        {currentSlide.table.rows.map((row, rIdx) => (
                          <tr
                            className={
                              rIdx % 2 === 0 ? "bg-muted/20" : "bg-transparent"
                            }
                            key={`tr-${rIdx}`}
                          >
                            {row.map((cell, cIdx) => (
                              <td
                                className="px-3 py-2 font-medium"
                                key={`td-${rIdx}-${cIdx}`}
                              >
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>

              {/* Footer Slide Indicator */}
              <div className="flex items-center justify-between border-border/20 border-t pt-3 text-[11px] opacity-60">
                <span>{preview.title}</span>
                <span className="font-bold">
                  {currentSlideIndex + 1} / {totalSlides}
                </span>
              </div>
            </div>
          </div>

          {/* Optional Speaker Notes Drawer */}
          {showNotes && currentSlide.notes ? (
            <div className="border-border border-t bg-card px-6 py-3 shadow-inner">
              <h5 className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                Speaker Notes
              </h5>
              <p className="mt-1 font-normal text-foreground text-xs sm:text-sm">
                {currentSlide.notes}
              </p>
            </div>
          ) : null}

          {/* Slide Navigation Controller */}
          <div className="flex items-center justify-between border-border border-t bg-card px-4 py-2.5 shadow-xs">
            <div className="flex items-center gap-1.5">
              <Button
                aria-label="Previous slide"
                className="size-8 p-0"
                disabled={currentSlideIndex <= 0}
                onClick={handlePrev}
                size="sm"
                type="button"
                variant="ghost"
              >
                <ArrowLeft01Icon className="size-4" />
              </Button>
              <span className="font-semibold text-foreground text-xs tabular-nums">
                Slide {currentSlideIndex + 1} of {totalSlides}
              </span>
              <Button
                aria-label="Next slide"
                className="size-8 p-0"
                disabled={currentSlideIndex >= totalSlides - 1}
                onClick={handleNext}
                size="sm"
                type="button"
                variant="ghost"
              >
                <ArrowRight01Icon className="size-4" />
              </Button>
            </div>

            <div className="text-muted-foreground text-xs">
              Use{" "}
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                ←
              </kbd>{" "}
              /{" "}
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                →
              </kbd>{" "}
              to navigate
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
