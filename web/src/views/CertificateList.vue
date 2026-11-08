<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { api, getActor, downloadCsv } from '../api';

const props = defineProps({ courses: { type: Array, default: () => [] } });
const emit = defineEmits(['open']);

const items = ref([]);
const total = ref(0);
const page = ref(1);
const size = ref(20);
const loading = ref(false);
const error = ref('');
const q = ref('');
const sort = ref('local_date');
const order = ref('desc');
const lastFetched = ref({});

// Bulk issue state
const bulkCourse = ref('');
const bulkRunning = ref(false);
const bulkError = ref('');
const bulkResult = ref(null);
const bulkKey = ref('');
const showBulk = ref(false);

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / size.value)));

function params(pg = page.value) {
  const p = { page: String(pg), size: String(size.value), sort: sort.value, order: order.value };
  if (q.value.trim()) p.q = q.value.trim();
  return p;
}

async function fetchList(pg) {
  loading.value = true;
  error.value = '';
  const startedAt = Date.now();
  lastFetched.value = { ...params(pg), at: startedAt };
  try {
    const data = await api.list(params(pg));
    if (lastFetched.value.at !== startedAt) return; // superseded
    items.value = data.items;
    total.value = data.total;
    page.value = data.page;
  } catch (e) {
    error.value = e.message || 'failed to load certificates';
  } finally {
    loading.value = false;
  }
}

function runSearch() {
  page.value = 1;
  fetchList(1);
}

function toggleSort(col) {
  if (sort.value === col) order.value = order.value === 'asc' ? 'desc' : 'asc';
  else {
    sort.value = col;
    order.value = col === 'local_date' ? 'desc' : 'asc';
  }
  runSearch();
}

function goPage(p) {
  if (p >= 1 && p <= totalPages.value) fetchList(p);
}

async function exportCsv() {
  error.value = '';
  try {
    await downloadCsv(params());
  } catch (e) {
    error.value = e.message || 'export failed';
  }
}

let searchTimer = null;
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 300);
}

async function runBulk() {
  const courseId = Number(bulkCourse.value);
  if (!courseId) {
    bulkError.value = 'choose a course first';
    return;
  }
  bulkRunning.value = true;
  bulkError.value = '';
  bulkResult.value = null;
  const key = crypto.randomUUID();
  bulkKey.value = key;
  try {
    bulkResult.value = await api.bulk(courseId, key);
  } catch (e) {
    bulkError.value = e.message || 'bulk issue failed';
  } finally {
    bulkRunning.value = false;
  }
  fetchList();
}

onMounted(() => fetchList());
watch(
  () => props.courses,
  (c) => {
    if (!bulkCourse.value && c.length) bulkCourse.value = String(c[0].id);
  }
);
</script>

<template>
  <div>
    <section class="panel">
      <h2>Certificates</h2>

      <div class="toolbar">
        <input
          v-model="q"
          type="text"
          placeholder="Search learner name or serial…"
          @input="onSearch"
          style="min-width: 260px"
          aria-label="Search certificates"
        />
        <button class="ghost" :disabled="loading" @click="runSearch">Search</button>
        <button class="ghost" :disabled="loading" @click="exportCsv" title="Export current search and sort as CSV">
          Export CSV
        </button>
        <button @click="showBulk = !showBulk">Bulk issue…</button>
      </div>

      <div v-if="showBulk" class="panel bulk-result" style="border: 1px dashed var(--line)">
        <h2>Bulk issue certificates</h2>
        <div class="toolbar">
          <label for="course">Course</label>
          <select id="course" v-model="bulkCourse">
            <option v-for="c in courses" :key="c.id" :value="String(c.id)">{{ c.title }}</option>
          </select>
          <button :disabled="bulkRunning" @click="runBulk">
            {{ bulkRunning ? 'Issuing…' : `Issue to all eligible learners` }}
          </button>
          <span v-if="bulkRunning" class="section-note">Operation running — duplicate submissions are disabled.</span>
        </div>
        <p v-if="bulkKey" class="section-note">Idempotency-Key: {{ bulkKey }}</p>
        <p v-if="bulkError" class="state-error">{{ bulkError }}</p>
        <div v-if="bulkResult" class="bulk-result">
          <p>
            <strong>{{ bulkResult.courseTitle }}</strong> —
            issued <span class="outcome-issued">{{ bulkResult.counts.issued }}</span>,
            skipped <span class="outcome-skipped">{{ bulkResult.counts.skipped }}</span>.
          </p>
          <table>
            <thead><tr><th>Learner</th><th>Outcome</th><th>Reason / Serial</th></tr></thead>
            <tbody>
              <tr v-for="o in bulkResult.outcomes" :key="o.learnerId">
                <td>{{ o.name }}</td>
                <td :class="o.outcome === 'issued' ? 'outcome-issued' : 'outcome-skipped'">{{ o.outcome }}</td>
                <td>{{ o.reason || o.serial }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <p v-if="error" class="state-error">
        <span>{{ error }}</span>
        <button @click="fetchList()">Retry</button>
      </p>
      <p v-else-if="loading" class="state-loading">Loading certificates…</p>
      <p v-else-if="!items.length" class="state-empty">No certificates found.</p>

      <template v-else>
        <table>
          <thead>
            <tr>
              <th @click="toggleSort('learner_name')">Learner <span class="arrow" v-if="sort==='learner_name'">{{ order==='asc'?'↑':'↓' }}</span></th>
              <th @click="toggleSort('serial')">Serial <span class="arrow" v-if="sort==='serial'">{{ order==='asc'?'↑':'↓' }}</span></th>
              <th @click="toggleSort('local_date')">Issue date (tenant-local) <span class="arrow" v-if="sort==='local_date'">{{ order==='asc'?'↑':'↓' }}</span></th>
              <th>Course</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in items" :key="row.id" class="clickable" @click="emit('open', row.id)">
              <td>{{ row.learner_name }}</td>
              <td>{{ row.serial }}</td>
              <td>{{ row.local_date }}</td>
              <td>{{ row.course_title }}</td>
              <td><span class="status-tag" :class="`status-${row.status}`">{{ row.status }}</span></td>
            </tr>
          </tbody>
        </table>
        <div class="pagination">
          <button :disabled="page <= 1 || loading" @click="goPage(page - 1)">← Prev</button>
          <span>Page {{ page }} of {{ totalPages }} · {{ total }} certificates</span>
          <button :disabled="page >= totalPages || loading" @click="goPage(page + 1)">Next →</button>
        </div>
      </template>
    </section>
  </div>
</template>