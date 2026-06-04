{{ config(
    materialized='incremental',
    unique_key='order_date',
    on_schema_change='append_new_columns'
) }}

select
    order_date,
    count(*) as order_count,
    sum(amount_usd) as revenue_usd
from {{ ref('sl_orders') }}
{% if is_incremental() %}
where order_date > (select coalesce(max(order_date), '1900-01-01') from {{ this }})
{% endif %}
group by 1
