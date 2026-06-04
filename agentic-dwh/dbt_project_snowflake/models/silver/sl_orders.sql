{{ config(materialized='table') }}

with src as (
    select * from {{ ref('br_orders') }}
)
select
    order_id,
    customer_id,
    order_ts,
    amount_usd,
    date_trunc('day', order_ts) as order_date
from src
where amount_usd >= 0
