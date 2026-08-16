# Quiet initial loader design

## Goal

Avoid showing connection or repository errors while GitNexus is still making
its initial server check, while preserving useful progress and confirmed error
feedback.

## Behavior

`LoadingOverlay` has three visible states:

1. **Initial validation**: a non-error progress value from 0 through 5 shows
   only the existing animated visual. It has no status text, progress bar, or
   percentage because the application has not yet begun loading a repository.
2. **Repository loading**: non-error progress above 5 shows the existing
   determinate bar, translated status text, optional detail, statistics, and
   percentage.
3. **Confirmed error**: the existing error message and detail remain visible
   after the connection request rejects. A failed request is not represented as
   `0%` progress, so the bar and percentage are hidden.

The behavior is local to the overlay. It does not add a shared pipeline phase,
change backend retries, or alter the redirect to onboarding after an error.

## Accessibility and validation

Visible loading copy uses a polite status region. Confirmed failures use an
alert region. Tests exercise all three user-visible states, including the
absence of premature connection copy.
