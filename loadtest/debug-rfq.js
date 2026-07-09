import http from 'k6/http'
const ctx = JSON.parse(open('./.ctx.json'))
export const options = { vus: 1, iterations: 1 }
export default function () {
  const res = http.post('http://localhost:3100/api/v1/rfq', JSON.stringify({
    category_slug: ctx.categorySlug,
    title: `Load test RFQ ${__VU}-${__ITER} — GST filing for small manufacturer`,
    details: { work_type: 'GST filing', notes: 'k6 debug' },
  }), { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.buyers[0].token}` } })
  console.log('STATUS', res.status)
  console.log('BODY', String(res.body).slice(0, 400))
}
