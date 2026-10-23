#!/usr/bin/env Rscript
# Merges the imaging lists in the Skjell_lister folder into ONE file, one row per fish.
#
# Usage (from anywhere):
#   Rscript scripts/merge_skjell_lister.R [input_folder] [output_file] [--include-backup] [--allow-decrease]
#
# Defaults: the project's Skjell_lister folder, and
#   <input_folder>/merged/scale_data_merged.xlsx
# (a sub-folder, so the merged file is never read back in as an input).
# Needs the R packages readxl, dplyr and writexl:
#   install.packages(c("readxl", "dplyr", "writexl"))
#
# What the lists are: every file (scale_data_<date>_<operator>.xlsx) is a copy of the
# SAME master list -- one row per fish, 18 columns -- in which an operator writes
# his or her name and the date (e.g. "Gunnel_23.10.26") in the Operator column of
# every fish imaged, and optionally a note in Comments. So the same fish appears in
# every file, and the files differ only in which fish are marked. The merge keeps one
# row per EnkeltfiskID:
#   * a row with an Operator beats an unmarked copy (the marked row also carries the
#     operator's other edits, e.g. a blanked Bildnavn_B when only one scale was imaged);
#   * if several files mark the same fish with the SAME operator and date, they are
#     duplicates: the one from the most recently saved file is kept;
#   * if they mark it with DIFFERENT operators, the latest operator date wins (ties:
#     the most recently saved file) and the fish is listed in merge_conflicts.csv
#     next to the output so someone can check it;
#   * a Comments value is never dropped: if the kept row has none, the comment from
#     another copy of the fish is used.
# Every file in the folder is read each time, so nothing is carried over between
# runs: keep all files in the folder (files in the "backup" sub-folder are ignored
# unless --include-backup is given). To make sure that moving a file away doesn't
# silently drop images, the script compares with the previous merged file and, when
# fish that were marked before are not marked now, stops without writing anything
# unless --allow-decrease is given.
#
# It also stops, writing nothing, if a file can't be read or lacks one of the 18 columns.

suppressPackageStartupMessages({
  library(readxl)
  library(dplyr)
  library(writexl)
})

DEFAULT_FOLDER <- "C:/Users/malte.willmes/OneDrive - NINA/Shortcuts/132668 - NASCO Skjellvekst - Documents/Skjell_lister"

# The columns every list must have, and what they are read as. Any other column is
# kept as text.
LIST_COLUMNS <- c(
  EnkeltfiskID = "numeric", Lopenr = "numeric", Feltaar = "numeric", Sjoalder = "numeric",
  region = "text", Lregnr = "text", Objektnavn = "text", Dato = "date", Lengde = "numeric",
  Vekt = "numeric", nummer = "numeric", selection = "text",
  Bildnavn_A_fw = "text", Bildnavn_A = "text", Bildnavn_B_Fw = "text", Bildnavn_B = "text",
  Operator = "text", Comments = "text"
)
# What the operators edit. The copies of a fish may differ in these, and only in these.
EDITED_COLUMNS <- c("Operator", "Comments", "Bildnavn_A_fw", "Bildnavn_A", "Bildnavn_B_Fw", "Bildnavn_B")

blank_to_na <- function(x) {
  x <- trimws(as.character(x))
  x[!is.na(x) & x == ""] <- NA_character_
  x
}

# "Gunnel_23.10.26" -> 2026-10-23 (NA when the Operator has no date at the end)
parse_operator_date <- function(operator) {
  parts <- regmatches(operator, regexec("([0-9]{1,2})\\.([0-9]{1,2})\\.([0-9]{2}|[0-9]{4})\\s*$", operator))
  as.Date(vapply(parts, function(p) {
    if (length(p) != 4) return(NA_character_)
    year <- as.integer(p[4])
    if (year < 100L) year <- year + 2000L
    sprintf("%04d-%02d-%02d", year, as.integer(p[3]), as.integer(p[2]))
  }, character(1)), optional = TRUE)
}

read_list <- function(path) {
  header <- names(read_excel(path, n_max = 0, .name_repair = "minimal"))
  if (anyDuplicated(header)) stop(sprintf("%s: duplicated column names", basename(path)), call. = FALSE)
  missing <- setdiff(names(LIST_COLUMNS), header)
  if (length(missing)) {
    stop(sprintf("%s: missing column(s): %s", basename(path), paste(missing, collapse = ", ")), call. = FALSE)
  }
  types <- ifelse(header %in% names(LIST_COLUMNS), LIST_COLUMNS[header], "text")
  df <- read_excel(path, col_types = unname(types), .name_repair = "minimal")
  df <- as_tibble(df)

  df$Dato <- as.Date(df$Dato)
  for (col in names(df)[vapply(df, is.character, logical(1))]) df[[col]] <- blank_to_na(df[[col]])
  if (anyNA(df$EnkeltfiskID)) {
    stop(sprintf("%s: %d row(s) without an EnkeltfiskID", basename(path), sum(is.na(df$EnkeltfiskID))), call. = FALSE)
  }
  df
}

list_files <- function(folder, include_backup, exclude) {
  dirs <- folder
  if (include_backup && dir.exists(file.path(folder, "backup"))) dirs <- c(dirs, file.path(folder, "backup"))
  files <- unlist(lapply(dirs, list.files, pattern = "\\.xlsx$", ignore.case = TRUE, full.names = TRUE))
  files <- files[!startsWith(basename(files), "~$")] # Excel's lock files while a list is open
  files <- files[!tolower(normalizePath(files, winslash = "/")) %in% tolower(exclude)]
  files
}

merge_skjell_lister <- function(folder = DEFAULT_FOLDER, output = NULL, include_backup = FALSE,
                                allow_decrease = FALSE) {
  say <- function(...) cat(sprintf(...), "\n", sep = "")
  folder <- normalizePath(folder, winslash = "/", mustWork = TRUE)
  if (is.null(output)) output <- file.path(folder, "merged", "scale_data_merged.xlsx")
  output <- normalizePath(output, winslash = "/", mustWork = FALSE)

  files <- list_files(folder, include_backup, exclude = output)
  if (!length(files)) stop(sprintf("No .xlsx lists found in %s", folder), call. = FALSE)
  info <- file.info(files)
  files <- files[order(info$mtime, files)] # oldest first
  info <- file.info(files)

  say("Merging %d list file(s) from %s", length(files), folder)
  lists <- lapply(seq_along(files), function(i) {
    df <- read_list(files[i])
    df$.file <- basename(files[i])
    df$.saved <- info$mtime[i]
    df
  })
  all <- bind_rows(lists)
  all$.seq <- seq_len(nrow(all))
  all$.has_operator <- !is.na(all$Operator)
  all$.has_comment <- !is.na(all$Comments)
  all$.operator_date <- parse_operator_date(all$Operator)

  per_file <- all |>
    group_by(.file) |>
    summarise(rows = n(), marked = sum(.has_operator), .groups = "drop")
  for (i in seq_len(nrow(per_file))) {
    say("  %-45s %6d rows, %4d fish with an operator", per_file$.file[i], per_file$rows[i], per_file$marked[i])
  }

  within_file <- sum(duplicated(all[c(".file", "EnkeltfiskID")]))

  # One row per fish: marked beats unmarked, then the latest operator date, then a row
  # with a comment, then the most recently saved file.
  ranked <- all |>
    arrange(EnkeltfiskID, desc(.has_operator), desc(.operator_date), desc(.has_comment), desc(.saved), desc(.file))
  merged <- ranked |> distinct(EnkeltfiskID, .keep_all = TRUE)

  # A comment on another copy is not lost when the kept row has none.
  comment_elsewhere <- ranked |>
    filter(.has_comment) |>
    distinct(EnkeltfiskID, .keep_all = TRUE) |>
    select(EnkeltfiskID, comment_elsewhere = Comments)
  merged <- merged |>
    left_join(comment_elsewhere, by = "EnkeltfiskID") |>
    mutate(Comments = coalesce(Comments, comment_elsewhere)) |>
    select(-comment_elsewhere)

  first_seen <- all |> group_by(EnkeltfiskID) |> summarise(.first = min(.seq), .groups = "drop")
  merged <- merged |>
    left_join(first_seen, by = "EnkeltfiskID") |>
    arrange(.first)

  # Fish marked by more than one operator: needs a person to look at it.
  conflicts <- all |>
    filter(.has_operator) |>
    group_by(EnkeltfiskID) |>
    filter(n_distinct(Operator) > 1) |>
    arrange(EnkeltfiskID, .saved) |>
    summarise(
      Objektnavn = first(Objektnavn), Feltaar = first(Feltaar), Sjoalder = first(Sjoalder),
      marked_by = paste0(Operator, " (", .file, ")", collapse = " | "),
      .groups = "drop"
    ) |>
    left_join(merged |> select(EnkeltfiskID, kept = Operator), by = "EnkeltfiskID")

  # The copies of a fish should differ only in what operators edit.
  other_cols <- setdiff(names(LIST_COLUMNS), c("EnkeltfiskID", EDITED_COLUMNS))
  differing <- all |>
    group_by(EnkeltfiskID) |>
    summarise(across(all_of(other_cols), ~ n_distinct(.x) > 1), .groups = "drop")
  differing_ids <- differing$EnkeltfiskID[rowSums(differing[other_cols]) > 0]

  n_files <- length(files)
  fish_in_some <- all |>
    group_by(EnkeltfiskID) |>
    summarise(in_files = n_distinct(.file), .groups = "drop") |>
    filter(in_files < n_files)

  out <- merged |> select(-starts_with("."))
  stopifnot(!anyDuplicated(out$EnkeltfiskID), nrow(out) == n_distinct(all$EnkeltfiskID))

  # Compare with the previous merge so that a file moved away doesn't silently drop images:
  # a merged file with fewer imaged fish than the last one is only written on request.
  lost <- character(0)
  if (file.exists(output)) {
    previous <- tryCatch(read_list(output), error = function(e) NULL)
    if (!is.null(previous)) {
      before <- previous$EnkeltfiskID[!is.na(previous$Operator)]
      now <- out$EnkeltfiskID[!is.na(out$Operator)]
      lost <- as.character(setdiff(before, now))
    }
  }
  if (length(lost) && !allow_decrease) {
    stop(sprintf(paste0(
      "%d fish that are marked as imaged in the previous merged file (e.g. %s) are not marked in these files, ",
      "so nothing was written. Was a list file removed or moved away, or a name deleted? Put the file back, ",
      "or run again with --allow-decrease if the change is intended."),
      length(lost), paste(head(lost, 3), collapse = ", ")), call. = FALSE)
  }

  dir.create(dirname(output), recursive = TRUE, showWarnings = FALSE)
  tmp <- tempfile(fileext = ".xlsx")
  write_xlsx(list(Sheet1 = out), tmp)
  if (!file.copy(tmp, output, overwrite = TRUE)) {
    stop(sprintf("Could not write %s (is it open in Excel?)", output), call. = FALSE)
  }
  unlink(tmp)

  conflicts_file <- file.path(dirname(output), "merge_conflicts.csv")
  if (nrow(conflicts)) {
    utils::write.csv(conflicts, conflicts_file, row.names = FALSE, fileEncoding = "UTF-8")
  } else if (file.exists(conflicts_file)) {
    unlink(conflicts_file)
  }

  marked <- out |> filter(!is.na(Operator))
  say("")
  say("Wrote %s", output)
  say("  %d fish (%d rows read, %d duplicate rows removed)", nrow(out), nrow(all), nrow(all) - nrow(out))
  say("  %d fish with an operator (imaged):", nrow(marked))
  by_operator <- marked |> count(Operator, name = "fish") |> arrange(Operator)
  for (i in seq_len(nrow(by_operator))) say("      %-25s %d", by_operator$Operator[i], by_operator$fish[i])
  if (within_file > 0) say("  NOTE: %d fish listed more than once within the same file", within_file)
  if (nrow(fish_in_some)) say("  NOTE: %d fish are not in every file", nrow(fish_in_some))
  if (length(differing_ids)) {
    say("  WARNING: %d fish differ between files in a column operators shouldn't edit (e.g. %s)",
        length(differing_ids), paste(head(differing_ids, 3), collapse = ", "))
  }
  if (nrow(conflicts)) {
    say("  WARNING: %d fish marked by DIFFERENT operators in different files -- the latest was kept; see %s",
        nrow(conflicts), conflicts_file)
  }
  if (length(lost)) {
    say("  NOTE: %d fish that were marked in the previous merged file are not marked now (accepted: --allow-decrease)",
        length(lost))
  }

  invisible(list(
    output = output, files = basename(files), fish = nrow(out), marked = nrow(marked),
    duplicates_removed = nrow(all) - nrow(out), conflicts = nrow(conflicts), lost_marks = lost
  ))
}

if (sys.nframe() == 0L) {
  args <- commandArgs(trailingOnly = TRUE)
  flags <- args[startsWith(args, "--")]
  positional <- args[!startsWith(args, "--")]
  result <- tryCatch(
    merge_skjell_lister(
      folder = if (length(positional) >= 1) positional[1] else DEFAULT_FOLDER,
      output = if (length(positional) >= 2) positional[2] else NULL,
      include_backup = "--include-backup" %in% flags,
      allow_decrease = "--allow-decrease" %in% flags
    ),
    error = function(e) {
      message("ERROR: ", conditionMessage(e))
      quit(status = 1)
    }
  )
}
