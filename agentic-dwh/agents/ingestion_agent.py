"""Intelligent Ingestion Agent — STUB.

In the diagram this owns Kafka / Near-Real-Time + Batch (ADF/AZ Copy/DUF/ECG)
loads landing into the UDLP Bronze layer. Out of scope for dbt-mcp.
"""
from __future__ import annotations
from agents.base import BaseAgent


class IngestionAgent(BaseAgent):
    name = "ingestion_agent"
    dbt_tools = None
    system = """You are the Intelligent Ingestion Agent. STUB only.

Respond with a JSON plan describing which source needs which connector
(Kafka topic, ADF pipeline, COPY INTO from S3/Azure Blob into Snowflake
Bronze) and the recommended cadence. Do not execute.
"""
