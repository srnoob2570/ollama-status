# Monitor stale alert spacing

## Goal

Create clear external separation around the `MONITOR STALE` alert without changing its text, colors, size, or the surrounding layout.

## Design

The stale-monitor notice will receive explicit vertical margins. The top margin separates it from the history-range control and the bottom margin separates it from the summary metrics. The spacing will follow the existing page rhythm used by the summary and panels.

## Scope

Only the notice styling used by the stale-monitor alert changes. No component structure, monitoring behavior, content, or responsive layout changes are included.

## Validation

Run the existing static checks after the CSS update and visually verify that the alert no longer touches the range selector or summary cards.
