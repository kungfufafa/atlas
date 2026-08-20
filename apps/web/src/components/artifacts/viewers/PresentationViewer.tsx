import type { PresentationPreview } from "@atlas/core";
import { ArrowLeft01Icon, ArrowRight01Icon, Note01Icon } from "hugeicons-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function PresentationViewer({
  preview,
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
  const themeColor = preview.themeColor || "#3B82F6";

  return (
    <div className="flex h-full w-full overflow-hidden bg-muted/20">
      <aside className="w-44 shrink-0 overflow-y-auto border-border border-r p-2">
        <div className="space-y-1.5">
          {slides.map((slide, idx) => {
            const isSelected = idx === currentSlideIndex;
            const isThumbDark =
              slide.backgroundColor === "#0F172A" ||
              (idx === 0 && !slide.backgroundColor);

            return (
              <button
                className={cn(
                  "w-full rounded-md border p-1.5 text-left",
                  isSelected
                    ? "border-foreground/20 bg-muted"
                    : "border-transparent hover:bg-muted/60"
                )}
                key={`${slide.slideIndex ?? idx}-${slide.title ?? "slide"}`}
                onClick={() => setCurrentSlideIndex(idx)}
                type="button"
              >
                <div
                  className={cn(
                    "flex aspect-video w-full flex-col justify-between overflow-hidden rounded p-2 text-[9px]",
                    isThumbDark
                      ? "bg-zinc-900 text-zinc-100"
                      : "bg-white text-zinc-900"
                  )}
                >
                  <span className="line-clamp-2 font-medium">
                    {slide.title || `Slide ${idx + 1}`}
                  </span>
                  <span className="self-end opacity-50">{idx + 1}</span>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="flex min-h-0 flex-1 flex-col">
        <main className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div
            className={cn(
              "relative flex aspect-video w-full max-w-4xl flex-col justify-between overflow-hidden rounded-lg p-8 shadow-sm sm:p-10",
              isDarkCover
                ? "bg-zinc-900 text-zinc-100"
                : "bg-white text-zinc-900"
            )}
            style={{
              backgroundColor:
                currentSlide.backgroundColor ||
                (isDarkCover ? "#0F172A" : "#FFFFFF"),
            }}
          >
            <div>
              {currentSlide.subtitle ? (
                <p
                  className="font-medium text-xs uppercase tracking-wide sm:text-sm"
                  style={{ color: themeColor }}
                >
                  {currentSlide.subtitle}
                </p>
              ) : null}
              {currentSlide.title ? (
                <h2
                  className={cn(
                    "mt-1 font-semibold tracking-tight",
                    currentSlide.layout === "title"
                      ? "text-center text-2xl sm:text-4xl"
                      : "text-xl sm:text-3xl"
                  )}
                >
                  {currentSlide.title}
                </h2>
              ) : null}
            </div>

            <div className="my-auto space-y-4">
              {currentSlide.bulletPoints &&
              currentSlide.bulletPoints.length > 0 ? (
                <ul className="space-y-2.5">
                  {currentSlide.bulletPoints.map((point, pointIndex) => (
                    <li
                      className="flex items-start gap-3 text-sm leading-relaxed sm:text-base"
                      key={`${currentSlide.slideIndex ?? currentSlideIndex}-bullet-${pointIndex}`}
                    >
                      <span
                        className="mt-1.5 size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: themeColor }}
                      />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {currentSlide.textBlocks && currentSlide.textBlocks.length > 0 ? (
                <div className="space-y-2">
                  {currentSlide.textBlocks.map((block, blockIndex) => (
                    <p
                      className="text-sm leading-relaxed sm:text-base"
                      key={`${currentSlide.slideIndex ?? currentSlideIndex}-block-${blockIndex}`}
                    >
                      {block}
                    </p>
                  ))}
                </div>
              ) : null}

              {currentSlide.table && currentSlide.table.headers.length > 0 ? (
                <div className="overflow-hidden rounded-md border border-black/10">
                  <table className="w-full text-left text-xs sm:text-sm">
                    <thead
                      className="text-white"
                      style={{ backgroundColor: themeColor }}
                    >
                      <tr>
                        {currentSlide.table.headers.map(
                          (header, headerIndex) => (
                            <th
                              className="px-3 py-2 font-medium"
                              key={`${currentSlide.slideIndex ?? currentSlideIndex}-header-${headerIndex}`}
                            >
                              {header}
                            </th>
                          )
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {currentSlide.table.rows.map((row, rowIndex) => (
                        <tr
                          className="border-black/5 border-t"
                          key={`${currentSlide.slideIndex ?? currentSlideIndex}-row-${rowIndex}`}
                        >
                          {row.map((cell, cellIndex) => (
                            <td
                              className="px-3 py-2"
                              key={`${currentSlide.slideIndex ?? currentSlideIndex}-cell-${rowIndex}-${cellIndex}`}
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
          </div>
        </main>

        {showNotes && currentSlide.notes ? (
          <div className="border-border border-t px-5 py-3 text-sm leading-relaxed">
            {currentSlide.notes}
          </div>
        ) : null}

        <div className="flex items-center justify-between border-border border-t px-3 py-1.5">
          <div className="flex items-center gap-1">
            <Button
              aria-label="Previous slide"
              className="size-7 p-0"
              disabled={currentSlideIndex <= 0}
              onClick={handlePrev}
              size="sm"
              type="button"
              variant="ghost"
            >
              <ArrowLeft01Icon className="size-4" />
            </Button>
            <span className="min-w-16 text-center text-muted-foreground text-xs tabular-nums">
              {currentSlideIndex + 1} / {totalSlides}
            </span>
            <Button
              aria-label="Next slide"
              className="size-7 p-0"
              disabled={currentSlideIndex >= totalSlides - 1}
              onClick={handleNext}
              size="sm"
              type="button"
              variant="ghost"
            >
              <ArrowRight01Icon className="size-4" />
            </Button>
          </div>

          {currentSlide.notes ? (
            <Button
              aria-label="Toggle speaker notes"
              className="size-7 p-0"
              onClick={() => setShowNotes((v) => !v)}
              size="sm"
              type="button"
              variant={showNotes ? "secondary" : "ghost"}
            >
              <Note01Icon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
