ALTER TABLE queued_message ADD COLUMN IF NOT EXISTS sending_at TIMESTAMP;

CREATE OR REPLACE FUNCTION stamp_message_delivery_lease() RETURNS trigger AS $$
BEGIN
  IF NEW.state = 'pending' THEN
    NEW.sending_at := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.sending_at := date_trunc('milliseconds', clock_timestamp());
  ELSIF OLD.state IS DISTINCT FROM NEW.state THEN
    NEW.sending_at := date_trunc('milliseconds', clock_timestamp());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS queued_message_delivery_lease ON queued_message;
CREATE TRIGGER queued_message_delivery_lease
BEFORE INSERT OR UPDATE OF state ON queued_message
FOR EACH ROW EXECUTE FUNCTION stamp_message_delivery_lease();