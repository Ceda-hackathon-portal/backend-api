-- Apply as migration owner, after runtime-role.sql. No access to authentication secrets or DDL.
GRANT SELECT,INSERT,UPDATE ON support_conversations,support_reads,support_agents,support_calls,alert_preferences,service_notifications,privacy_requests TO ceda_runtime;
GRANT SELECT,INSERT ON support_messages,service_audits TO ceda_runtime;
GRANT SELECT,INSERT,DELETE ON support_signals TO ceda_runtime;
GRANT USAGE,SELECT ON SEQUENCE support_signals_sequence_seq TO ceda_runtime;
GRANT SELECT ON decision_audits TO ceda_runtime;
