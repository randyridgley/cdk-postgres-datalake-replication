import json
import psycopg2
from psycopg2.extras import LogicalReplicationConnection, StopReplication
from psycopg2 import sql
import boto3
import botocore
import os
import logging
import ecs_logging

# Get the Logger
logger = logging.getLogger("pg2kinesis")
logger.setLevel(logging.DEBUG)
handler = logging.StreamHandler()
handler.setFormatter(ecs_logging.StdlibFormatter())
logger.addHandler(handler)

kinesis_client = boto3.client('kinesis')

pg_username = os.environ.get('POSTGRES_USER')
pg_password = os.environ.get('POSTGRES_PASSWORD')
pg_database = os.environ.get('POSTGRES_DB')
pg_hostname = os.environ.get('POSTGRES_HOST')

replication_slot_name = os.environ.get('REPLICATION_SLOT_NAME')
kinesis_stream_name = os.environ.get('REPLICATION_KINESIS_STREAM_NAME')

conn = psycopg2.connect(
    f"dbname='{pg_database}' host='{pg_hostname}' user='{pg_username}' password='{pg_password}'",
    connection_factory=LogicalReplicationConnection)
cur = conn.cursor()


class ReplicationConsumer(object):
    def __call__(self, msg):
        try:
            for idx, change in enumerate(json.loads(msg.payload)["change"]):
                try:
                    result = kinesis_client.put_record(
                        StreamName=kinesis_stream_name,
                        Data=json.dumps(change),
                        PartitionKey="default")
                    logger.info(f"sent individual change message successfully to kinesis",
                                extra={'msg_payload': json.dumps(change)})
                except botocore.exceptions.ClientError as error:
                    logger.warning(
                        f"Error transmitting record to kinesis",
                        extra={'error': str(error)})
        except BaseException as error:
            logger.warning("Failed to write to kinesis",
                           extra={
                               "error": str(error),
                           })
            raise error
        except:
            logger.warning("Failed to write to kinesis",
                            extra={
                                "error": str(error),
                            })

        msg.cursor.send_feedback(flush_lsn=msg.data_start)


replication_consumer = ReplicationConsumer()

logger.info("Starting streaming")
try:
    try:
      cur.start_replication(slot_name='wal2json',
                            options={'pretty-print': 1},
                            decode=True)
    except psycopg2.ProgrammingError:
        cur.create_replication_slot(
            replication_slot_name, output_plugin='wal2json')
        
        cur.start_replication(slot_name=replication_slot_name,
                              options={'pretty-print': 1},
                              decode=True)
    cur.consume_stream(replication_consumer)
except:
    cur.close()
    conn.close()
    logger.warning({
        "msg": "Transaction logs will accumulate in pg_xlog "
        "until the slot is dropped.",
    }, f"The slot '{replication_slot_name}' still exists. Drop it with "
        f"SELECT pg_drop_replication_slot('{replication_slot_name}'); if no longer needed.")
