-- How the assistant's answers were produced, from its Art 12 rows. Read
-- before and after each role (.github/workflows/garak.yml); the difference is
-- that role's turns. One line, four space-separated counts:
--
--   recorded        every assistant row
--   fromModel       rows carrying the provider's own token count: a model answered
--   deterministic   the keyword router answered (provider 'deterministic', no model)
--   modelUnreached  a model provider is named but no tokens were counted: the
--                   provider call failed and the loop answered with its
--                   "the language model was unavailable" notice
--
-- .garak/summarise.mjs turns them into NO_MODEL_TURNS / ANSWERS_NOT_FROM_MODEL.
SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE COALESCE("tokensIn", 0) + COALESCE("tokensOut", 0) > 0),
    COUNT(*) FILTER (WHERE provider = 'deterministic'),
    COUNT(*) FILTER (WHERE provider <> 'deterministic' AND COALESCE("tokensIn", 0) + COALESCE("tokensOut", 0) = 0)
FROM "AiDecisionLog"
WHERE feature = 'assistant';
