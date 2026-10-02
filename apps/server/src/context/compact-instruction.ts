/**
 * What the CLI's compaction command is told to keep when a member's round on a card ends (PM-213):
 * one line of English prompt text, typed after `/compact`. The summary replaces the conversation, so
 * the next round starts from it instead of re-reading the whole earlier round on every step.
 */
export const COMPACT_INSTRUCTION =
  'Summarise this conversation for your own later use on the same card. Keep: the card (its key, title, goal and acceptance criteria), the decisions made and why, the files you changed and the commits you made (paths and commit ids), the open questions, and every bug or review finding that is not fixed yet, with what is left to do. Leave out the contents of the files you read and the output of the commands you ran: you can read or run them again.';
