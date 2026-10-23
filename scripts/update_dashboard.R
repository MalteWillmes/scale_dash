#!/usr/bin/env Rscript
# Updates the live dashboard from the imaging lists (Skjell_lister) in one go.
#
# Usage (from anywhere):
#   Rscript scripts/update_dashboard.R [input_folder] [--no-push] [--allow-decrease] [--include-backup]
#
#   1. merges all list files into one (scripts/merge_skjell_lister.R) --
#      <input_folder>/merged/scale_data_merged.xlsx, one row per fish, duplicates removed;
#   2. rebuilds data/summary.json and data/history.json from the two top-15 workbooks in
#      data/ plus the merged list (scripts/build_summary.py --imaged-list ...): every fish
#      with a name in the Operator column counts as imaged;
#   3. if the numbers changed, commits those two files and pushes them to GitHub, and the
#      dashboard at https://maltewillmes.github.io/scale_dash/ updates within a minute or two.
#
#   --no-push          do steps 1-2 only (nothing is committed or pushed)
#   --allow-decrease   accept a merged list with FEWER imaged fish than the last one
#                      (otherwise the merge refuses -- see merge_skjell_lister.R)
#   --include-backup   also read the lists in the "backup" sub-folder
#
# Only counts per river, year and age class are published. The merged list itself holds
# fish-level records and stays in the Skjell_lister folder; the GitHub repo is public.
# Needs: R packages readxl, dplyr, writexl, jsonlite; Python with openpyxl (the `py`
# launcher or `python`); git with push access to the repo.

args <- commandArgs(trailingOnly = TRUE)
flags <- args[startsWith(args, "--")]
positional <- args[!startsWith(args, "--")]

script_file <- sub("^--file=", "", grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)[1])
script_dir <- dirname(normalizePath(script_file, winslash = "/", mustWork = TRUE))
repo <- dirname(script_dir)

fail <- function(...) {
  message("ERROR: ", sprintf(...))
  quit(status = 1)
}
say <- function(...) cat(sprintf(...), "\n", sep = "")

for (pkg in c("readxl", "dplyr", "writexl", "jsonlite")) {
  if (!requireNamespace(pkg, quietly = TRUE)) fail("R package '%s' is not installed: install.packages(\"%s\")", pkg, pkg)
}

run <- function(cmd, cmd_args, what) {
  if (grepl(" ", cmd, fixed = TRUE)) cmd <- shQuote(cmd, type = "cmd")
  out <- suppressWarnings(system2(cmd, shQuote(cmd_args, type = "cmd"), stdout = TRUE, stderr = TRUE))
  status <- attr(out, "status")
  if (!is.null(status) && status != 0L) fail("%s failed (exit %d):\n%s", what, status, paste(out, collapse = "\n"))
  out
}

# ---- 1. merge the lists -----------------------------------------------------------------
source(file.path(script_dir, "merge_skjell_lister.R"), local = TRUE)
folder <- if (length(positional) >= 1) positional[1] else DEFAULT_FOLDER
merged <- tryCatch(
  merge_skjell_lister(
    folder, include_backup = "--include-backup" %in% flags, allow_decrease = "--allow-decrease" %in% flags
  ),
  error = function(e) fail("%s", conditionMessage(e))
)

# ---- 2. rebuild the dashboard data ------------------------------------------------------
data_dir <- file.path(repo, "data")
workbooks <- file.path(data_dir, c("d_1SW_top15.xlsx", "d_2SW_top15.xlsx"))
if (!all(file.exists(workbooks))) fail("The top-15 workbooks are missing: %s", paste(workbooks[!file.exists(workbooks)], collapse = ", "))
python <- Sys.which("py")
if (python == "") python <- Sys.which("python")
if (python == "") fail("Python was not found (looked for `py` and `python`)")

published <- file.path(data_dir, c("summary.json", "history.json"))
rel <- c("data/summary.json", "data/history.json")

# What is published is what is committed: that is what the new numbers are compared with
# (not the working copy, which may hold an earlier run that was never pushed).
head_summary <- tempfile(fileext = ".json")
head_status <- suppressWarnings(system2(
  "git", shQuote(c("-C", repo, "show", paste0("HEAD:", rel[1])), type = "cmd"), stdout = head_summary, stderr = FALSE
))
have_head <- identical(as.integer(head_status), 0L)

say("")
say("Rebuilding %s ...", "data/summary.json and data/history.json")
out <- run(
  python,
  c(file.path(repo, "scripts", "build_summary.py"), workbooks, file.path(data_dir, "summary.json"),
    "--imaged-list", merged$output),
  "build_summary.py"
)
cat(grep("^(Imaging list|WARNING)", out, value = TRUE), sep = "\n")

# The summary carries a timestamp, so compare everything else: nothing to publish if the
# numbers are the same as in the published version. (A new day's history entry with the same
# totals changes nothing on the page, so history.json doesn't count either.)
strip_time <- function(f) { s <- jsonlite::fromJSON(f, simplifyVector = FALSE); s$generatedAt <- NULL; s }
if (have_head && identical(strip_time(head_summary), strip_time(published[1]))) {
  run("git", c("-C", repo, "checkout", "--", rel), "git checkout") # drop the timestamp-only change
  say("")
  say("No change in the numbers since the published version (%d fish imaged by operators): nothing to publish.", merged$marked)
  quit(status = 0)
}

summary <- jsonlite::fromJSON(published[1], simplifyVector = FALSE)
say("Dashboard data updated (%d rivers, data as of %s).", length(summary$rivers), summary$generatedAt)

if ("--no-push" %in% flags) {
  say("--no-push: the two data files are rebuilt in %s but not committed or pushed.", data_dir)
  quit(status = 0)
}

# ---- 3. commit and push -----------------------------------------------------------------
git <- function(...) run("git", c("-C", repo, ...), paste("git", ..1))
branch <- trimws(git("rev-parse", "--abbrev-ref", "HEAD"))
if (branch != "master") fail("The repo is on branch '%s'; the dashboard is published from 'master'. Check out master first.", branch)

git("add", "--", rel)
message_text <- sprintf("Update imaging data: %d fish imaged by operators (%s)", merged$marked, format(Sys.time(), "%Y-%m-%d %H:%M"))
git("commit", "-m", message_text, "--", rel) # only these two files, whatever else is staged
push_out <- tryCatch(git("push"), error = function(e) fail("%s\nIf the remote has newer commits: git pull --rebase, then run this again.", conditionMessage(e)))
say("")
say("Committed and pushed: %s", message_text)
say("Live in a minute or two: https://maltewillmes.github.io/scale_dash/")
