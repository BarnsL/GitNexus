# Loading overlay states

The full-screen loader uses progress to decide when it should communicate
status:

- **0 to 5%, non-error:** initial server validation. GitNexus shows the loading
  visual without a status message, bar, or percentage.
- **More than 5%, non-error:** graph download or processing. GitNexus shows the
  translated status, detail, progress bar, statistics, and percentage.
- **Error phase:** GitNexus shows the confirmed error and its detail, without a
  progress bar or percentage.

This is a presentation rule only. Server connection, retries, and the delayed
return to onboarding are unchanged.
