<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { api, setActor } from './api';
import CertificateList from './views/CertificateList.vue';
import CertificateDetail from './views/CertificateDetail.vue';

const schema = ref({ tenants: [], admins: [], courses: [] });
const actorEmail = ref('');
const view = ref({ name: 'list' });

const currentAdmin = computed(() =>
  schema.value.admins.find((a) => a.email === actorEmail.value)
);
const tenantCourses = computed(() =>
  schema.value.courses.filter((c) => c.tenant_id === currentAdmin.value?.tenant_id)
);

onMounted(async () => {
  try {
    const s = await api.schema();
    schema.value = s;
    if (s.admins.length) {
      actorEmail.value = s.admins[0].email;
    }
  } catch (e) {
    console.error('schema load failed', e);
  }
});

// Any actor change re-binds the header and forces a fresh list fetch via the
// `<main :key="actorEmail">` remount below. Driven by the reactive value, so it
// does not depend on the select's `change` event ordering.
watch(actorEmail, (email) => {
  if (!email) return;
  setActor(email);
  view.value = { name: 'list' };
});

function openDetail(id) {
  view.value = { name: 'detail', id };
}
</script>

<template>
  <div class="app">
    <header class="app-header">
      <h1>Certificate Admin Console</h1>
      <div class="actor-box">
        <label for="actor">Acting as</label>
        <select id="actor" v-model="actorEmail">
          <option v-for="a in schema.admins" :key="a.email" :value="a.email">
            {{ a.email }}
          </option>
        </select>
        <span class="tenant">{{ currentAdmin?.tenant_slug }}</span>
      </div>
    </header>

    <main v-if="actorEmail" :key="actorEmail">
      <template v-if="view.name === 'detail'">
        <button class="back" @click="view = { name: 'list' }">← Certificates</button>
        <CertificateDetail :id="view.id" />
      </template>
      <CertificateList v-else :courses="tenantCourses" @open="openDetail" />
    </main>
    <p v-else class="state-loading">Loading actor context…</p>
  </div>
</template>