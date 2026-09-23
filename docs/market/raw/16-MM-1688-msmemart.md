# AMClub market survey — 1688.com (16) and MSME Global Mart (MM) — public pages, lighter pass

23 Sep 2026 · not logged in to either · ≈15 min total. Safety: no forms, no uploads. The **1688 product-detail page threw a CAPTCHA** ("Captcha Interception"), so I stopped there (rule 6). The MSME Mart launch-video popup was left alone.

---

# 1688.com (16)

Pages: search results for 焊条 (welding electrodes), "Find Factory" (找工厂) results. Chrome auto-translated part of the UI; Chinese terms are kept with their English meaning.

| ID | Area | Feature | What it does (observed) | Persona | Where | Evidence | AMClub status | How theirs differs from ours |
|---|---|---|---|---|---|---|---|---|
| 16-01 | Discovery | **Dual mode tabs** | 找货源 Find goods (spot buying) · 找工厂 Find factory (custom processing / OEM) · 找供应商 Find supplier · 工业品 Industrial products · 找服务 Find service · 找分销商 Find dropshipper | all | s.1688.com | Observed | CHECK (AMC Mart goods + goods RFQ) | The same keyword can be searched as *products to buy now* or *factories to make it*. This is the dual mode AMC Mart copies |
| 16-02 | Search | "您想找的是" (did you mean) chips | Silver / stainless / carbon-steel / copper electrodes, solder bars | all | search | Observed | CHECK | Disambiguates intent before results |
| 16-03 | Search | Deep attribute facets | Core diameter (2.5/3.2 mm), product type (stainless, nickel, cast-iron, hard-facing, heat-resistant, low-alloy), material (308L…), flux yes/no; advanced: length, imported, export-only supply, **authorisable own brand**, origin, coating type, main sales region, welding position, **downstream platform**, weight, melting point, welding current, brand, pack size | all | search | Observed | THEIRS-BETTER (for AMC Mart) | Category-specific typed attributes feed the facets |
| 16-04 | Search | Sorts | 综合 overall · 销量 sales volume · 价格 price · **起订量 MOQ range** · 店铺商品数 store SKU count · 所在地区 region · 商家特色 merchant features · 经营模式 business model (manufacturer/trader) | all | search | Observed | PARITY/CHECK | MOQ range as a sort/filter |
| 16-05 | Search | Service-promise filters | 合并供应商 merge same supplier · **极速开票 fast invoicing** · 工业严选 industrial curated · **高回头率 high repeat-purchase rate** · 新人首单优惠 first-order discount · 包邮 free shipping · **退货包运费 return shipping covered** · 一件代发 single-piece dropship · 官方物流 official logistics · **48H发货 ships within 48 h** | all | search | Observed | MISSING (most) | Fulfilment promises you can filter on. "Fast invoicing" matters for GST-style tax invoices |
| 16-06 | Credit&Finance | **先采后付 "buy now, pay later"** tag on listings | BNPL shown at card level | buyer | search cards | Observed | LATER (NBFC credit) | — |
| 16-07 | Listing | "定制" customisable tag | Card-level tag that the product can be customised | all | search cards | Observed | MISSING | The link from spot buying to custom processing |
| 16-08 | Trust | **回头率 repeat-purchase rate** on every card (40%, 47%, 54%) | Share of buyers who reorder (Chrome mistranslates it as "return rate") | all | cards | Observed | MISSING | Strong quality proxy (as on Alibaba) |
| 16-09 | Analytics | Demand signals on cards | "Monthly visits 2000+", "**100+ peers are watching**" (同行在看), "hot-list top 9", "N items sold across the network" | all | cards | Observed | CHECK | "Peers are watching" is social proof from competitors |
| 16-10 | Ads&Monetisation | "Limited time price" | Promo pricing tag | all | cards | Observed | N/A | — |
| 16-11 | Verification | **Factory profile metrics (找工厂)** | Factory area (m²), headcount band, years, "Super factory", "Gold medal manufacturing", **response rate %, fulfilment rate %, repeat rate %**, diamond level, integrity level (AA), CCC certification, "supports foreign-trade orders", processing tags | all | factory_search | Observed | THEIRS-BETTER | Capability facts (area, headcount) plus measured performance (fulfilment %) on one card |
| 16-12 | Search | Factory filters | Region clusters (Xingtai, Shenzhen, Shanghai, Jinhua, Linyi, Dongguan, Tianjin, Hangzhou, Foshan…), sort by repeat rate, **factory area**, **OEM model (代工模式)**, **factory qualification**, **quality certification**, super factory, fast customisation | all | factory_search | Observed | MISSING (cluster/region-first search) | Industrial clusters are first-class filters. Relevant to "Kurnool fabrication cluster" |
| 16-13 | Search | Image search + browser plugin | "Comparison shopping via image… paste an image or link… install the 1688 plugin for price comparison across the web" | all | search header | Observed | MISSING | — |

**1688 takeaways for AMC Mart:**
- Put **Buy now (spot) and Make to order (custom/加工定制)** as two tabs on the same query, both shown for Kurnool cluster sellers.
- Show **repeat-purchase %**, **fulfilment %** and **ships within 48 h** as card-level facts, all computed from our own order events.
- Offer **"return shipping covered"** and **"fast GST invoice"** as seller-level promises buyers can filter on.

**Not verified (CAPTCHA):**
- Detail-page tiered pricing (阶梯价).
- Sample ordering.
- The 加工定制 order flow (drawing upload → quote → proofing/打样 → production).

---

# MSME Global Mart (MM) — msmemart.com (NSIC, Ministry of MSME)

Pages: home, membership.

| ID | Area | Feature | What it does (observed) | Persona | Where | Evidence | AMClub status | How theirs differs from ours |
|---|---|---|---|---|---|---|---|---|
| MM-01 | Other | Govt-backed B2B directory ("MSME Global Mart 2.0", launched 27 Jun 2026) | Directory of companies, products and leads; search across All members / Sellers / Buyers / **Service providers** | all | / | Observed | N/A | Directory, no transactions |
| MM-02 | Seller-tools | **Tender alerts + Award-of-Contract (AOC) data** | "Keyword-based unlimited tender alerts"; "detailed info on tenders awarded in the past, **including L-1**"; live domestic tenders on home | seller | /membership, home | Observed | MISSING | Useful for AMClub's govt & licensing and GeM-onboarding providers |
| MM-03 | Membership | Gold membership | ₹6,000 + 18% GST = **₹7,080/yr**; **75% subsidy for micro units under the PMS scheme** (member pays ₹1,500 + GST) | seller | /membership | Observed | LATER (membership tiers) | A govt subsidy lowers the price for micro units |
| MM-04 | Other | Franchise / subcontracting / distribution opportunities | "Offer / avail sub-contracting, franchise and distributorship opportunities" | all | /membership | Observed | N/A | — |
| MM-05 | RFQ | "Source from India — Request a Quote" | RFQ banner in the ticker | buyer | home | Observed (not opened) | PARITY | — |
| MM-06 | Other | Free MSME (Udyam) registration link; "Inclusive procurement"; State e-Pavilions; "Login for PSUs"; ICT digital solutions | Menus | all | header | Observed | PARITY (company registration category) | PSU buyers log in separately |
| MM-07 | Seller-tools | Buyer/supplier tools list | Buyers: trade-alert watch, manage your trade. Suppliers: access global buyers, post products, post leads, 24×7 visibility | all | home sidebar | Observed | N/A | — |
| MM-08 | Other | Accessibility | Text-size −A/A/+A, skip to main content, language selector | all | header | Observed | CHECK | — |

**MSME Mart takeaways:**
- The government channel sells **tender alerts plus L-1 award history**. AMClub could offer tender/GeM alerts as a **provider growth tool** (free, earned by verified providers) rather than a paid membership.
- The **PMS 75% subsidy** is a hook. Check whether AMClub providers or buyers can claim scheme subsidies for our fees (open question for you).
