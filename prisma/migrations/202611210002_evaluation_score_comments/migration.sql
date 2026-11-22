BEGIN;

-- Developer B's published scoring contract can require criterion-specific comments.
-- Nullable preserves existing drafts and supports criteria that do not require a comment.
ALTER TABLE "evaluation_scores"
  ADD COLUMN "comment" VARCHAR(4000);

COMMIT;
