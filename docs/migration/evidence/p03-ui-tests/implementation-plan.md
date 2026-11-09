# UI test validator maintenance

Recognize only literal positive safe-integer timeout options on nonempty direct node:test callbacks. Preserve two-argument discovery, explicit platform selection, duplicate rejection, and all eight original callbacks. Reject skip/todo and all other dynamic or suppressing options. This package changes validator recognition, with no app/runtime/Store changes. No performance optimization or timeout-budget increase is included.
