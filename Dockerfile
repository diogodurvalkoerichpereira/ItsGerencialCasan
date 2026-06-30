FROM nginx:alpine
COPY index.html /usr/share/nginx/html/index.html
COPY cadastro-operador.html /usr/share/nginx/html/cadastro-operador.html
COPY perfis-acesso.html /usr/share/nginx/html/perfis-acesso.html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://localhost/ || exit 1
