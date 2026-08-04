library(jsonlite)

user_log_info <- function(msg, ...) {
    user_log_emit("info", sprintf(msg, ...))
}

user_log_warn <- function(msg, ...) {
    user_log_emit("warn", sprintf(msg, ...))
}

user_log_error <- function(msg, ...) {
    user_log_emit("error", sprintf(msg, ...))
}

user_log_emit <- function(level, msg) {
    cat(jsonlite::toJSON(list(
        user_visible = TRUE,
        level = level,
        msg = msg
    ), auto_unbox = TRUE), "\n", sep = "")
}
