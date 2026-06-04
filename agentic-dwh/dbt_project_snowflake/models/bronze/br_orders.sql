{{ config(materialized='view') }}

select
    order_id,
    customer_id,
    order_ts::timestamp_ntz as order_ts,
    amount_cents,
    amount_cents / 100.0 as amount_usd
from {{ source('raw', 'orders') }}
