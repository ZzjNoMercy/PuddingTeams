"use client";

/* eslint-disable react-hooks/set-state-in-effect -- vendored from deer-flow; timer/streaming state transitions */

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, memo, useContext, useEffect, useState } from "react";
import { ThinkIcon } from "@/components/icons/think-icon";
import { reasoningPlugins } from "@/core/streamdown/plugins";
import { Shimmer } from "./shimmer";
import { ClipboardSafeStreamdown } from "./streamdown";

type ReasoningContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
  startTime: number | null;
};

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
  startTimeProp?: number | null;
  onTurnDurationChange?: (duration: number | undefined) => void;
};

const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen = false,
    onOpenChange,
    duration: durationProp,
    startTimeProp,
    onTurnDurationChange,
    children,
    ...props
  }: ReasoningProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });
    const [duration, setDuration] = useControllableState<number | undefined>({
      prop: durationProp,
      defaultProp: undefined,
      onChange: onTurnDurationChange,
    });

    const [startTime, setStartTime] = useState<number | null>(
      () => startTimeProp ?? (isStreaming ? Date.now() : null),
    );

    // Track duration when streaming starts and ends
    useEffect(() => {
      if (isStreaming) {
        // Force sync the start time with the Turn start time if provided
        if (startTimeProp != null && startTime !== startTimeProp) {
          setStartTime(startTimeProp);
        } else if (startTimeProp == null && startTime === null) {
          setStartTime(Date.now());
        }
      } else if (startTime !== null) {
        setDuration(Math.floor((Date.now() - startTime) / MS_IN_S));
        setStartTime(null);
      }
    }, [isStreaming, startTimeProp, startTime, setDuration]);

    const handleOpenChange = (newOpen: boolean) => {
      setIsOpen(newOpen);
    };

    return (
      <ReasoningContext.Provider
        value={{ isStreaming, isOpen, setIsOpen, duration, startTime }}
      >
        <Collapsible
          className={cn("not-prose mb-4", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  },
);

export type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  getThinkingMessage?: (
    isStreaming: boolean,
    duration?: number,
    startTime?: number | null,
  ) => ReactNode;
  hasContent?: boolean;
};

// 整轮时长由 RunProcessSection 统一显示；推理行只表达「正在想 / 想完了」，
// 避免同一个 bubble 里出现两个跳动时钟。
const defaultGetThinkingMessage = (isStreaming: boolean) =>
  isStreaming ? (
    <Shimmer duration={1}>深度思考中</Shimmer>
  ) : (
    <span>已深度思考</span>
  );

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    hasContent = true,
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration, startTime } = useReasoning();

    return (
      <CollapsibleTrigger
        className={cn(
          "text-muted-foreground hover:text-foreground flex w-full items-center gap-2 text-sm transition-colors",
          !hasContent && "cursor-default",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <ThinkIcon className="size-4 shrink-0" />
            {getThinkingMessage(isStreaming, duration, startTime)}
            {hasContent && (
              isOpen ? (
                <ChevronDownIcon className="size-4" />
              ) : (
                <ChevronRightIcon className="size-4" />
              )
            )}
          </>
        )}
      </CollapsibleTrigger>
    );
  },
);

export type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string;
};

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => (
    <CollapsibleContent
      className={cn(
        "mt-2 max-h-72 overflow-y-auto rounded-lg border border-border/70 bg-muted/30 px-3 py-2.5 text-sm",
        "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground data-[state=closed]:animate-out data-[state=open]:animate-in outline-none",
        className,
      )}
      {...props}
    >
      <ClipboardSafeStreamdown {...reasoningPlugins}>
        {children}
      </ClipboardSafeStreamdown>
    </CollapsibleContent>
  ),
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
