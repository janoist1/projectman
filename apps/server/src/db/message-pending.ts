/**
 * One derivation for migration backfill and transactional repository writes. JSON is expanded only
 * after validation. Missing/empty/JSON-null receipts are legacy; malformed receipts mean [].
 * Message kind and routing belong to the delivery layer, not to this recipient index.
 */
export const PENDING_MESSAGE_RECIPIENTS = `SELECT DISTINCT m.id, m.project_key, recipient.value, m.seq
  FROM team_messages AS m
  JOIN json_each(CASE WHEN json_valid(m.to_handles) THEN
    CASE WHEN json_type(m.to_handles) = 'array' THEN m.to_handles ELSE '[]' END
    ELSE '[]' END) AS recipient
  WHERE recipient.type = 'text' AND
    CASE WHEN m.receipts IS NULL OR m.receipts = '' THEN COALESCE(m.delivered_at, '') = ''
      WHEN json_valid(m.receipts) THEN
        CASE json_type(m.receipts)
          WHEN 'null' THEN COALESCE(m.delivered_at, '') = ''
          WHEN 'array' THEN EXISTS (
            SELECT 1 FROM json_each(m.receipts) AS receipt
            WHERE CASE WHEN receipt.type = 'object' THEN
              json_extract(receipt.value, '$.handle') = recipient.value
              AND json_extract(receipt.value, '$.kind') = 'ai'
              AND COALESCE(json_extract(receipt.value, '$.deliveredAt'), '') = ''
              ELSE 0 END)
          ELSE 0 END
      ELSE 0 END`;
